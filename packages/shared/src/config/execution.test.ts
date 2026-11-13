import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultConfig } from './defaults.js';
import {
  EXECUTION_ENV,
  defaultExecutionConcurrency,
  isExecutionFailMode,
  isExecutionFallback,
  isExecutionMode,
  isExecutionPooling,
  isExecutionPoolProvider,
  parseExecutionUrlList,
  resolveBrowserProfileNames,
  resolveExecutionConfig,
  resolveExecutionProfileNames,
  resolveExecutionMode,
  type ResolvedExecutionProfile,
} from './execution.js';
import {
  DEFAULT_EXECUTION_PROVISIONER_TIMEOUT_MS,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  EXECUTION_FALLBACKS,
  EXECUTION_POOLINGS,
  EXECUTION_POOL_PROVIDERS,
  type SynthConfig,
} from './types.js';

const cfg: SynthConfig = defaultConfig;

function withExecution(partial: Partial<SynthConfig['execution']>): SynthConfig {
  return {
    ...cfg,
    execution: { ...cfg.execution, ...partial },
  };
}

/**
 * Фикстура `execution.remote`: дефолты секции + точечные переопределения.
 * Нужна, чтобы новые поля (PROP-135 Ф4a/Ф4b) не дублировались в каждом литерале.
 */
function withRemote(
  partial: Partial<SynthConfig['execution']['remote']>,
): SynthConfig {
  return withExecution({ remote: { ...cfg.execution.remote, ...partial } });
}

/** Профиль каталога для проверок имён (значения не важны). */
function profileStub(
  overrides: Partial<ResolvedExecutionProfile> = {},
): ResolvedExecutionProfile {
  return {
    url: [],
    timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS,
    concurrency: 1,
    failMode: 'fail',
    ...overrides,
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
    const c = withRemote({
      url: ['http://cfg-executor:8080'],
      timeoutMs: 1000,
      concurrency: 2,
      failMode: 'fail',
      tokenSecret: '/cfg/token',
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
    const c = withRemote({
      url: ['http://cfg-executor:8080'],
      timeoutMs: 5000,
      concurrency: 3,
      failMode: 'inline-fallback',
      tokenSecret: '/cfg/token',
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
    const c = withRemote({
      url: [],
      timeoutMs: 30_000,
      concurrency: 1,
      failMode: 'fallback' as never,
      tokenSecret: '',
    });
    expect(() => resolveExecutionConfig(c, {})).toThrow(/execution\.remote\.failMode="fallback"/);
  });

  it('невалидный числовой env → warn и фоллэк на config (fail-soft)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = withRemote({
      url: [],
      timeoutMs: 1234,
      concurrency: 4,
      failMode: 'fail',
      tokenSecret: '',
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

  it('дефолты browser-пула: приходят из схемы и резолвера', () => {
    expect(cfg.execution.remote.browserProfile).toBe('browser');
    expect(cfg.execution.remote.browserMcpServer).toBe('playwright-mcp');
    // Резолвер не подменяет дефолты: браузер не наследует `defaultProfile`.
    const resolved = resolveExecutionConfig(cfg, {});
    expect(resolved.remote.browserProfile).toBe('browser');
    expect(resolved.remote.browserMcpServer).toBe('playwright-mcp');
  });

  it('browserProfile: env важнее config.yaml; пустое значение → дефолт', () => {
    const c = withExecution({
      remote: { ...cfg.execution.remote, browserProfile: 'browser-dev' },
    });
    expect(resolveExecutionConfig(c, {}).remote.browserProfile).toBe('browser-dev');
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.browserProfile]: 'browser-env' }).remote
        .browserProfile,
    ).toBe('browser-env');
    // Пустое env-значение — «не задано» → берётся config.
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.browserProfile]: '' }).remote.browserProfile,
    ).toBe('browser-dev');
    // Пустое в config — тоже «не задано» → дефолт.
    const empty = withExecution({
      remote: { ...cfg.execution.remote, browserProfile: '' },
    });
    expect(resolveExecutionConfig(empty, {}).remote.browserProfile).toBe('browser');
  });

  it('browserProfiles: дефолт пуст, env (csv) важнее config.yaml, нормализация', () => {
    // Дефолт — пустой список: эффективный каталог равен `[browserProfile]`.
    expect(cfg.execution.remote.browserProfiles).toEqual([]);
    expect(resolveExecutionConfig(cfg, {}).remote.browserProfiles).toEqual([]);

    // config.yaml: trim, пустые и дубли отбрасываются.
    const c = withRemote({
      browserProfiles: [' browser-full ', '', 'browser-full', 'browser-mobile'],
    });
    expect(resolveExecutionConfig(c, {}).remote.browserProfiles).toEqual([
      'browser-full',
      'browser-mobile',
    ]);

    // env (csv) приоритетнее config.yaml.
    expect(
      resolveExecutionConfig(c, {
        [EXECUTION_ENV.browserProfiles]: 'browser-env, browser-full ,, browser-env',
      }).remote.browserProfiles,
    ).toEqual(['browser-env', 'browser-full']);

    // Пустое env-значение — «не задано» → берётся config.
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.browserProfiles]: '' }).remote.browserProfiles,
    ).toEqual(['browser-full', 'browser-mobile']);
  });

  it('resolveBrowserProfileNames: пусто → [browserProfile]; resolveExecutionProfileNames исключает браузерные', () => {
    // Импортируются ниже в этом же файле (см. верхний импорт).
    expect(resolveBrowserProfileNames({ browserProfiles: [], browserProfile: 'browser' })).toEqual([
      'browser',
    ]);
    expect(resolveBrowserProfileNames({ browserProfile: '' })).toEqual([]);

    const names = resolveExecutionProfileNames({
      profiles: {
        default: profileStub(),
        devops: profileStub(),
        browser: profileStub(),
        'browser-full': profileStub(),
      },
      defaultProfile: 'default',
      browserProfiles: ['browser', 'browser-full'],
      browserProfile: 'browser',
    });
    expect(names).toContain('default');
    expect(names).toContain('devops');
    expect(names).not.toContain('browser');
    expect(names).not.toContain('browser-full');

    // defaultProfile не исключается, даже если совпал с браузерным именем.
    expect(
      resolveExecutionProfileNames({
        profiles: {},
        defaultProfile: 'browser',
        browserProfiles: ['browser'],
        browserProfile: 'browser',
      }),
    ).toEqual(['browser']);
  });

  it('класс профиля (ADR-135 §11): объявленный → по browserProfiles → browserProfile → exec', () => {
    const remote = {
      profiles: {
        execOne: profileStub(),
        browserOne: profileStub({ class: 'browser' as const }),
        bothOne: profileStub({ class: 'both' as const }),
        legacyBrowser: profileStub(),
        defaultBrowser: profileStub(),
      },
      defaultProfile: 'execOne',
      browserProfiles: ['legacyBrowser'],
      browserProfile: 'defaultBrowser',
    };

    // Браузерный каталог: класс browser/both + legacy-список + browserProfile.
    expect(resolveBrowserProfileNames(remote)).toEqual([
      'legacyBrowser',
      'browserOne',
      'bothOne',
      'defaultBrowser',
    ]);
    // Exec-каталог: класс exec/both + профиль по умолчанию.
    expect(resolveExecutionProfileNames(remote)).toEqual([
      'execOne',
      'bothOne',
    ]);
  });

  it('browserMcpServer: env важнее config.yaml; пустое значение → дефолт', () => {
    const c = withExecution({
      remote: { ...cfg.execution.remote, browserMcpServer: 'browser-mcp' },
    });
    expect(resolveExecutionConfig(c, {}).remote.browserMcpServer).toBe('browser-mcp');
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.browserMcpServer]: 'playwright-env' }).remote
        .browserMcpServer,
    ).toBe('playwright-env');
    expect(
      resolveExecutionConfig(c, { [EXECUTION_ENV.browserMcpServer]: '' }).remote.browserMcpServer,
    ).toBe('browser-mcp');
    const empty = withExecution({
      remote: { ...cfg.execution.remote, browserMcpServer: '' },
    });
    expect(resolveExecutionConfig(empty, {}).remote.browserMcpServer).toBe('playwright-mcp');
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
          inherits: { url: [] },
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

  it('метаданные профиля (description/image/network/resources/runtimeClass/mcpServers)', () => {
    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        profiles: {
          described: {
            url: ['http://a:8080'],
            description: '  Инстанс-исполнитель test  ',
            image: ' synth-executor:0.13.9-full ',
            network: 'restricted',
            resources: {
              requests: { cpu: '500m', memory: '  ' },
              limits: { memory: '2Gi' },
            },
            runtimeClass: ' gvisor ',
            mcpServers: [' playwright ', ''],
          },
          empty: {
            url: ['http://b:8080'],
            description: '   ',
            image: '',
            mcpServers: [],
          },
        },
      },
    });
    const resolved = resolveExecutionConfig(c, {});

    expect(resolved.remote.profiles.described).toEqual({
      url: ['http://a:8080'],
      timeoutMs: cfg.execution.remote.timeoutMs,
      concurrency: cfg.execution.remote.concurrency,
      failMode: 'fail',
      description: 'Инстанс-исполнитель test',
      image: 'synth-executor:0.13.9-full',
      network: 'restricted',
      resources: { requests: { cpu: '500m' }, limits: { memory: '2Gi' } },
      runtimeClass: 'gvisor',
      mcpServers: [{ name: 'playwright' }],
    });
    // Пустые значения «не заданы»: метаданных в резолве нет вовсе.
    expect(resolved.remote.profiles.empty).toEqual({
      url: ['http://b:8080'],
      timeoutMs: cfg.execution.remote.timeoutMs,
      concurrency: cfg.execution.remote.concurrency,
      failMode: 'fail',
    });
    expect('description' in resolved.remote.profiles.empty!).toBe(false);
    expect('resources' in resolved.remote.profiles.empty!).toBe(false);
  });

  it('placement-поля профиля и произвольные ресурсы (GPU) доезжают в резолв', () => {
    const c = withRemote({
      profiles: {
        gpu: {
          url: ['http://gpu:8080'],
          image: 'synth-executor:0.13.9-full',
          annotations: { 'example.com/owner': 'platform' },
          labels: { 'example.com/tier': 'gpu' },
          nodeSelector: { 'example.com/pool': 'gpu' },
          tolerations: [{ key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' }],
          affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {} } },
          resources: {
            requests: { cpu: '1', 'nvidia.com/gpu': '1' },
            limits: { 'nvidia.com/gpu': '1' },
          },
        },
      },
    });
    const resolved = resolveExecutionConfig(c, {});
    const profile = resolved.remote.profiles.gpu;

    expect(profile?.annotations).toEqual({ 'example.com/owner': 'platform' });
    expect(profile?.labels).toEqual({ 'example.com/tier': 'gpu' });
    expect(profile?.nodeSelector).toEqual({ 'example.com/pool': 'gpu' });
    expect(profile?.tolerations).toEqual([
      { key: 'nvidia.com/gpu', operator: 'Exists', effect: 'NoSchedule' },
    ]);
    expect(profile?.affinity).toEqual({
      nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {} },
    });
    // Произвольные ресурсы не теряются (GPU).
    expect(profile?.resources?.requests).toEqual({ cpu: '1', 'nvidia.com/gpu': '1' });
    expect(profile?.resources?.limits).toEqual({ 'nvidia.com/gpu': '1' });
  });

  it('профиль без адресов при пустом общем url → непригоден (url пуст)', () => {    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        url: [],
        profiles: { broken: { url: [] } },
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

/**
 * PROP-135 Ф4b-1: провайдер пулов (`static`|`http`) и параметры provisioner'а.
 */
describe('провайдер пулов (PROP-135 Ф4b-1)', () => {
  it('дефолты: provider=static, provisioner пустой, таймаут 10 с', () => {
    const resolved = resolveExecutionConfig(cfg, {});
    expect(resolved.remote.provider).toBe('static');
    expect(resolved.remote.provisioner.url).toBe('');
    expect(resolved.remote.provisioner.tokenSecret).toBe('');
    expect(resolved.remote.provisioner.timeoutMs).toBe(DEFAULT_EXECUTION_PROVISIONER_TIMEOUT_MS);
    expect(resolved.remote.provisioner.timeoutMs).toBe(10_000);
  });

  it('provider: env важнее config.yaml', () => {
    const c = withExecution({
      remote: { ...cfg.execution.remote, provider: 'static' as const },
    });
    expect(resolveExecutionConfig(c, {}).remote.provider).toBe('static');
    // `http` требует адрес provisioner'а — иначе fail-closed (см. ниже).
    expect(
      resolveExecutionConfig(c, {
        [EXECUTION_ENV.provider]: 'http',
        [EXECUTION_ENV.provisionerUrl]: 'http://provisioner:8080',
      }).remote.provider,
    ).toBe('http');
  });

  it('provider: fail-closed на неизвестном значении (env и config)', () => {
    expect(() => resolveExecutionConfig(cfg, { [EXECUTION_ENV.provider]: 'htpp' })).toThrow(
      /SYNTH_EXECUTION_PROVIDER="htpp"/,
    );
    const c = withExecution({ remote: { ...cfg.execution.remote, provider: 'htpp' as never } });
    expect(() => resolveExecutionConfig(c, {})).toThrow(/execution\.remote\.provider="htpp"/);
  });

  it('provider=http без адреса provisioner\'а → ошибка конфигурации (fail-closed)', () => {
    const c = withExecution({ remote: { ...cfg.execution.remote, provider: 'http' as const } });
    expect(() => resolveExecutionConfig(c, {})).toThrow(
      /execution\.remote\.provider="http" требует адрес provisioner/,
    );
    // Пустой env-адрес — тоже «не задан».
    expect(() =>
      resolveExecutionConfig(c, { [EXECUTION_ENV.provisionerUrl]: '' }),
    ).toThrow(/требует адрес provisioner/);
  });

  it('provisioner: url/token/timeout — env важнее config.yaml', () => {
    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        provider: 'http' as const,
        provisioner: {
          url: 'http://cfg-provisioner:8080',
          tokenSecret: '/cfg/provisioner-token',
          timeoutMs: 5_000,
        },
      },
    });
    const fromCfg = resolveExecutionConfig(c, {});
    expect(fromCfg.remote.provisioner.url).toBe('http://cfg-provisioner:8080');
    expect(fromCfg.remote.provisioner.tokenSecret).toBe('/cfg/provisioner-token');
    expect(fromCfg.remote.provisioner.timeoutMs).toBe(5_000);

    const fromEnv = resolveExecutionConfig(c, {
      [EXECUTION_ENV.provisionerUrl]: 'http://env-provisioner:8080',
      [EXECUTION_ENV.provisionerToken]: '/env/provisioner-token',
      [EXECUTION_ENV.provisionerTimeoutMs]: '2500',
    });
    expect(fromEnv.remote.provisioner.url).toBe('http://env-provisioner:8080');
    expect(fromEnv.remote.provisioner.tokenSecret).toBe('/env/provisioner-token');
    expect(fromEnv.remote.provisioner.timeoutMs).toBe(2_500);
  });

  it('provisioner.timeoutMs: невалидный env → warn и фоллбэк на config (fail-soft)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        provider: 'http' as const,
        provisioner: {
          url: 'http://cfg-provisioner:8080',
          tokenSecret: '',
          timeoutMs: 7_000,
        },
      },
    });
    const resolved = resolveExecutionConfig(c, {
      [EXECUTION_ENV.provisionerTimeoutMs]: 'не-число',
    });
    expect(resolved.remote.provisioner.timeoutMs).toBe(7_000);
    expect(warn).toHaveBeenCalled();
  });

  it('пустое значение env → тихий фоллбэк на config/дефолт', () => {
    const c = withExecution({
      remote: {
        ...cfg.execution.remote,
        provider: 'http' as const,
        provisioner: { url: 'http://cfg-provisioner:8080', tokenSecret: '/cfg/token', timeoutMs: 3_000 },
      },
    });
    const resolved = resolveExecutionConfig(c, {
      [EXECUTION_ENV.provisionerUrl]: '',
      [EXECUTION_ENV.provisionerToken]: '',
      [EXECUTION_ENV.provisionerTimeoutMs]: '',
    });
    expect(resolved.remote.provisioner.url).toBe('http://cfg-provisioner:8080');
    expect(resolved.remote.provisioner.tokenSecret).toBe('/cfg/token');
    expect(resolved.remote.provisioner.timeoutMs).toBe(3_000);
  });

  it('предикат провайдера пулов', () => {
    expect(EXECUTION_POOL_PROVIDERS).toEqual(['static', 'http']);
    expect(isExecutionPoolProvider('static')).toBe(true);
    expect(isExecutionPoolProvider('http')).toBe(true);
    expect(isExecutionPoolProvider('htpp')).toBe(false);
    expect(isExecutionPoolProvider(undefined)).toBe(false);
  });
});

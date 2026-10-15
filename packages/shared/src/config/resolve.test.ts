import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { resolveDataDir, resolvePort, resolveDefaultWorkspace, resolveWorkspacesRoot, resolveWorkspaceOutsideRootPolicy, resolveSecretKey, resolveIgnoreRules, resolveHome, defaultConfigPath, findConfigPath, resolveProfilesPath, resolveCredentialsPath, ensureFirstRun } from './resolve.js';
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

  it('регрессия (ADR-075): относительный env.SYNTH_DATA_DIR → абсолютный', () => {
    const env = { SYNTH_DATA_DIR: 'rel/data' };
    const result = resolveDataDir(cfg, env);
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/data'));
  });

  it('регрессия (ADR-075): относительный config.storage.dataDir → абсолютный', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, dataDir: 'rel/cfg-data' } };
    const result = resolveDataDir(c, {});
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/cfg-data'));
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

describe('resolveDefaultWorkspace', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('использует env.SYNTH_DEFAULT_WORKSPACE в первую очередь', () => {
    const env = { SYNTH_DEFAULT_WORKSPACE: '/from/env' };
    expect(resolveDefaultWorkspace(cfg, env)).toBe('/from/env');
  });

  it('использует config.storage.defaultWorkspace если env не задан', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, defaultWorkspace: '/cfg/ws' } };
    expect(resolveDefaultWorkspace(c, {})).toBe('/cfg/ws');
  });

  it('приоритет env > config > дефолт', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, defaultWorkspace: '/cfg/ws' } };
    const env = { SYNTH_DEFAULT_WORKSPACE: '/env/ws' };
    expect(resolveDefaultWorkspace(c, env)).toBe('/env/ws');
  });

  it('дефолт = join(dataDir, workspaces, default)', () => {
    expect(resolveDefaultWorkspace(cfg, {})).toBe('/test/data/workspaces/default');
  });

  it('дефолт резолвится от dataDir из env.SYNTH_DATA_DIR', () => {
    const env = { SYNTH_DATA_DIR: '/custom/data' };
    expect(resolveDefaultWorkspace(cfg, env)).toBe('/custom/data/workspaces/default');
  });

  it('НЕ читает реальный process.env, если передан env', () => {
    vi.stubEnv('SYNTH_DEFAULT_WORKSPACE', '/should-not-be-used');
    expect(resolveDefaultWorkspace(cfg, {})).toBe('/test/data/workspaces/default');
  });

  it('регрессия (ADR-075): относительный env.SYNTH_DEFAULT_WORKSPACE → абсолютный', () => {
    const result = resolveDefaultWorkspace(cfg, { SYNTH_DEFAULT_WORKSPACE: 'rel/def' });
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/def'));
  });

  it('регрессия (ADR-075): относительный config.storage.defaultWorkspace → абсолютный', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, defaultWorkspace: 'rel/cfg-def' } };
    const result = resolveDefaultWorkspace(c, {});
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/cfg-def'));
  });

  it('регрессия (ADR-075): относительный env.SYNTH_DATA_DIR → абсолютный default', () => {
    const result = resolveDefaultWorkspace(cfg, { SYNTH_DATA_DIR: 'rel/data' });
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/data/workspaces/default'));
  });
});

describe('resolveWorkspacesRoot (ADR-075: регрессия относительных путей)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('абсолютный env.SYNTH_WORKSPACES_ROOT → как есть', () => {
    expect(resolveWorkspacesRoot(cfg, { SYNTH_WORKSPACES_ROOT: '/abs/ws' })).toBe('/abs/ws');
  });

  it('относительный env.SYNTH_WORKSPACES_ROOT → абсолютный', () => {
    const result = resolveWorkspacesRoot(cfg, { SYNTH_WORKSPACES_ROOT: 'rel/ws' });
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/ws'));
  });

  it('относительный config.storage.workspacesRoot → абсолютный', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, workspacesRoot: 'rel/cfg-ws' } };
    const result = resolveWorkspacesRoot(c, {});
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/cfg-ws'));
  });

  it('относительный env.SYNTH_DATA_DIR → абсолютный fallback', () => {
    const result = resolveWorkspacesRoot(cfg, { SYNTH_DATA_DIR: 'rel/data' });
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/data/workspaces'));
  });

  it('относительный config.storage.dataDir → абсолютный fallback', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, dataDir: 'rel/cfg-data' } };
    const result = resolveWorkspacesRoot(c, {});
    expect(isAbsolute(result)).toBe(true);
    expect(result).toBe(resolvePath('rel/cfg-data/workspaces'));
  });
});

describe('resolveWorkspaceOutsideRootPolicy (ADR-075)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('env.SYNTH_WORKSPACE_OUTSIDE_ROOT приоритетнее config', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, workspaceOutsideRoot: 'deny' } };
    expect(resolveWorkspaceOutsideRootPolicy(c, { SYNTH_WORKSPACE_OUTSIDE_ROOT: 'confirm' })).toBe('confirm');
  });

  it('config.storage.workspaceOutsideRoot используется, если env не задан', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, workspaceOutsideRoot: 'deny' } };
    expect(resolveWorkspaceOutsideRootPolicy(c, {})).toBe('deny');
  });

  it('невалидное env-значение игнорируется → config', () => {
    const c: SynthConfig = { ...cfg, storage: { ...cfg.storage, workspaceOutsideRoot: 'deny' } };
    expect(resolveWorkspaceOutsideRootPolicy(c, { SYNTH_WORKSPACE_OUTSIDE_ROOT: 'allow' })).toBe('deny');
  });

  it('дефолт — пустая строка', () => {
    expect(resolveWorkspaceOutsideRootPolicy(cfg, {})).toBe('');
  });

  it('не читает реальный process.env, если передан env без переменной', () => {
    vi.stubEnv('SYNTH_WORKSPACE_OUTSIDE_ROOT', 'deny');
    expect(resolveWorkspaceOutsideRootPolicy(cfg, {})).toBe('');
  });
});

// Функциональные тесты для ensureDataDir и createDefaultConfig
// require доступа к реальной ФС, поэтому используют настоящие mkdir/writeFile
// или оставлены интеграционными (ручной запуск с tmp).

describe('ensureFirstRun (ADR-075: нормализация относительного --data-dir)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('относительный dataDirOverride → абсолютный dataDir (запись в tmp)', async () => {
    vi.stubEnv('SYNTH_DEPLOY_MODE', 'dev');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    dir = await mkdtemp(join(tmpdir(), 'synth-firstrun-'));
    // Относительный путь, лексически указывающий на временный каталог,
    // чтобы ensureDataDir не создавал подкаталоги в рабочем/домашнем каталоге.
    const dataDirOverride = relative(process.cwd(), dir);
    const configPathOverride = join(dir, 'config.yaml');

    const result = await ensureFirstRun(dataDirOverride, configPathOverride);

    expect(isAbsolute(dataDirOverride)).toBe(false);
    expect(isAbsolute(result.dataDir)).toBe(true);
    expect(result.dataDir).toBe(resolvePath(dataDirOverride));
    expect(result.dataDir).toBe(dir);
    // ensureDataDir отработал по абсолютизированному пути — подкаталоги в tmp.
    expect(existsSync(join(dir, 'sessions'))).toBe(true);
  });
});

describe('resolveSecretKey (ADR-076)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('env SYNTH_SECRET_KEY имеет приоритет над config', () => {
    const c: SynthConfig = { ...cfg, security: { ...cfg.security, secretKey: 'from-config' } };
    expect(resolveSecretKey(c, { SYNTH_SECRET_KEY: 'from-env' })).toBe('from-env');
  });

  it('config.security.secretKey используется, если env не задан', () => {
    const c: SynthConfig = { ...cfg, security: { ...cfg.security, secretKey: 'from-config' } };
    expect(resolveSecretKey(c, {})).toBe('from-config');
  });

  it('дефолт — пустая строка', () => {
    expect(resolveSecretKey(cfg, {})).toBe('');
  });

  it('НЕ читает реальный process.env, если передан env без переменной', () => {
    vi.stubEnv('SYNTH_SECRET_KEY', 'should-not-be-used');
    expect(resolveSecretKey(cfg, {})).toBe('');
  });
});

describe('resolveIgnoreRules (ADR-069 §9.2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('явный флаг (--ignore-rules/--safe-mode) приоритетнее env', () => {
    expect(resolveIgnoreRules(true, { SYNTH_IGNORE_RULES: '0' })).toBe(true);
  });

  it('env SYNTH_IGNORE_RULES=1|true включает нейтральный режим', () => {
    expect(resolveIgnoreRules(false, { SYNTH_IGNORE_RULES: '1' })).toBe(true);
    expect(resolveIgnoreRules(undefined, { SYNTH_IGNORE_RULES: 'true' })).toBe(true);
    expect(resolveIgnoreRules(undefined, { SYNTH_IGNORE_RULES: 'TRUE' })).toBe(true);
  });

  it('прочие значения env и отсутствие флага — выключено', () => {
    expect(resolveIgnoreRules(false, { SYNTH_IGNORE_RULES: '0' })).toBe(false);
    expect(resolveIgnoreRules(false, { SYNTH_IGNORE_RULES: '' })).toBe(false);
    expect(resolveIgnoreRules(false, {})).toBe(false);
    expect(resolveIgnoreRules(undefined, undefined)).toBe(false);
  });

  it('НЕ читает реальный process.env, если передан env без переменной', () => {
    vi.stubEnv('SYNTH_IGNORE_RULES', '1');
    expect(resolveIgnoreRules(undefined, {})).toBe(false);
  });
});

describe('resolveHome (ADR-079)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('явный флаг приоритетнее env.SYNTH_HOME', () => {
    expect(resolveHome('/flag/home', { SYNTH_HOME: '/env/home' })).toBe(resolvePath('/flag/home'));
  });

  it('env.SYNTH_HOME используется, если флаг не задан', () => {
    expect(resolveHome(null, { SYNTH_HOME: '/env/home' })).toBe(resolvePath('/env/home'));
  });

  it('пусто (нет флага и env) → null', () => {
    expect(resolveHome(null, {})).toBeNull();
    expect(resolveHome('', {})).toBeNull();
  });

  it('относительный флаг → абсолютный', () => {
    const result = resolveHome('rel/home', {});
    expect(isAbsolute(result!)).toBe(true);
    expect(result).toBe(resolvePath('rel/home'));
  });

  it('НЕ читает реальный process.env, если передан env без SYNTH_HOME', () => {
    vi.stubEnv('SYNTH_HOME', '/should-not-be-used');
    expect(resolveHome(null, {})).toBeNull();
  });
});

describe('resolveDataDir с home (ADR-079)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('home и нет SYNTH_DATA_DIR/config → <home>/data', () => {
    expect(resolveDataDir(defaultConfig, {}, '/h')).toBe(join('/h', 'data'));
  });

  it('home через env.SYNTH_HOME → <home>/data', () => {
    expect(resolveDataDir(defaultConfig, { SYNTH_HOME: '/env/home' }, null)).toBe(
      join('/env/home', 'data'),
    );
  });

  it('SYNTH_DATA_DIR приоритетнее home', () => {
    expect(resolveDataDir(defaultConfig, { SYNTH_DATA_DIR: '/env/data' }, '/h')).toBe('/env/data');
  });

  it('config.storage.dataDir приоритетнее home', () => {
    expect(resolveDataDir(cfg, {}, '/h')).toBe('/test/data');
  });
});

describe('defaultConfigPath (ADR-079)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('с home → <home>/config.yaml (независимо от mode)', () => {
    expect(defaultConfigPath('user', '/h')).toBe(join('/h', 'config.yaml'));
    expect(defaultConfigPath('dev', '/h')).toBe(join('/h', 'config.yaml'));
  });
});

describe('findConfigPath (ADR-079)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('с home: существующий <home>/config.yaml → возвращает путь', async () => {
    vi.stubEnv('SYNTH_CONFIG', '');
    dir = await mkdtemp(join(tmpdir(), 'synth-findcfg-'));
    const configPath = join(dir, 'config.yaml');
    await writeFile(configPath, 'core: {}\n', 'utf-8');
    expect(findConfigPath(dir)).toBe(configPath);
  });

  it('с home: отсутствует <home>/config.yaml → null (без отката к cwd/XDG)', async () => {
    vi.stubEnv('SYNTH_CONFIG', '');
    dir = await mkdtemp(join(tmpdir(), 'synth-findcfg-'));
    expect(findConfigPath(dir)).toBeNull();
  });
});

describe('resolveProfilesPath / resolveCredentialsPath (ADR-079)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('с home → <home>/profiles.json и <home>/credentials.json', () => {
    expect(resolveProfilesPath('/h')).toBe(join('/h', 'profiles.json'));
    expect(resolveCredentialsPath('/h')).toBe(join('/h', 'credentials.json'));
  });

  it('без home → XDG-дефолт ~/.config/synth/...', () => {
    vi.stubEnv('SYNTH_HOME', '');
    vi.stubEnv('HOME', '/home/user');
    expect(resolveProfilesPath(null)).toBe(join('/home/user', '.config', 'synth', 'profiles.json'));
    expect(resolveCredentialsPath(null)).toBe(join('/home/user', '.config', 'synth', 'credentials.json'));
  });
});

describe('ensureFirstRun с home (ADR-079)', () => {
  let dir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('dataDir = <home>/data, config = <home>/config.yaml создан', async () => {
    vi.stubEnv('SYNTH_DEPLOY_MODE', 'dev');
    vi.stubEnv('SYNTH_DATA_DIR', '');
    vi.stubEnv('SYNTH_CONFIG', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    dir = await mkdtemp(join(tmpdir(), 'synth-home-firstrun-'));

    const result = await ensureFirstRun(undefined, undefined, dir);

    expect(result.dataDir).toBe(join(dir, 'data'));
    expect(result.configPath).toBe(join(dir, 'config.yaml'));
    expect(existsSync(join(dir, 'config.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'data', 'sessions'))).toBe(true);
  });
});

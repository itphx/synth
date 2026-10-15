import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import type { SynthConfig } from './types.js';
import type { WorkspaceOutsideRootPolicy } from '../types/index.js';
import { DEFAULT_MAX_UPLOAD_BYTES, MIN_UPLOAD_BYTES, MAX_UPLOAD_BYTES_LIMIT } from '../types/index.js';
import { defaultConfig } from './defaults.js';

export type DeployMode = 'user' | 'docker' | 'server' | 'dev';

const DATA_SUBDIRS = [
  'sessions',
  'projects',
  'providers',
  'models',
  'agents',
  'context/user',
  'context/roles',
  'auth/avatars',
  'auth/profiles',
  'auth/sessions',
  'auth/states',
  'workspaces',
  'workspaces/default',
];

const DOCKER_MARKERS = ['/.dockerenv', '/run/.containerenv'];

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

export function resolveDeployMode(): DeployMode {
  if (process.env.SYNTH_DEPLOY_MODE) {
    const mode = process.env.SYNTH_DEPLOY_MODE;
    if (['user', 'docker', 'server', 'dev'].includes(mode)) return mode as DeployMode;
  }

  for (const marker of DOCKER_MARKERS) {
    if (existsSync(marker)) return 'docker';
  }

  if (process.getuid && process.getuid() === 0) return 'server';

  if (process.env.SYNTH_AUTH_DEBUG === 'true') return 'dev';

  return 'user';
}

/**
 * ADR-079: базовый home-каталог локального инстанса. Приоритет: явный флаг
 * (`explicitHome`) > env `SYNTH_HOME` > null (XDG-дефолты). Возвращает
 * абсолютный путь либо null.
 */
export function resolveHome(
  explicitHome?: string | null,
  env?: NodeJS.ProcessEnv,
): string | null {
  const raw = explicitHome ?? (env ?? process.env).SYNTH_HOME;
  if (!raw) return null;
  return resolve(raw);
}

export function resolveDataDir(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
  home?: string | null,
): string {
  // ADR-075: нормализуем к абсолютному пути — относительный dataDir ломает
  // containment-проверки FS (root остаётся относительным, target — абсолютным).
  const envVar = (env ?? process.env).SYNTH_DATA_DIR;
  if (envVar) return resolve(envVar);

  if (config.storage.dataDir && config.storage.dataDir !== defaultConfig.storage.dataDir) {
    return resolve(config.storage.dataDir);
  }

  // ADR-079: home-каталог задаёт плоскую раскладку (<home>/data) и приоритетнее
  // mode-дефолтов, но ниже явных SYNTH_DATA_DIR/config.storage.dataDir.
  const h = resolveHome(home, env);
  if (h) return join(h, 'data');

  const mode = resolveDeployMode();
  switch (mode) {
    case 'user':   return join(homeDir(), '.local', 'share', 'synth');
    case 'dev':    return join(process.cwd(), 'data');
    default:       return '/var/synth/data';
  }
}

export function findConfigPath(home?: string | null): string | null {
  const explicit = process.env.SYNTH_CONFIG;
  if (explicit) return explicit;

  // ADR-079: при заданном home конфиг — строго <home>/config.yaml (приоритетнее
  // cwd/XDG); отсутствие файла не откатывается к дефолтам.
  const h = resolveHome(home);
  if (h) {
    const homePath = join(h, 'config.yaml');
    return existsSync(homePath) ? homePath : null;
  }

  const cwd = process.cwd();

  const localNames = ['synth.config.yaml', 'config.yaml'];
  for (const name of localNames) {
    const path = join(cwd, name);
    if (existsSync(path)) return path;
  }

  const mode = resolveDeployMode();
  switch (mode) {
    case 'user': {
      const homePath = join(homeDir(), '.config', 'synth', 'config.yaml');
      if (existsSync(homePath)) return homePath;
      return null;
    }
    case 'dev': {
      return null;
    }
    default: {
      if (existsSync('/etc/synth/config.yaml')) return '/etc/synth/config.yaml';
      return null;
    }
  }
}

export function defaultConfigPath(mode?: DeployMode, home?: string | null): string {
  // ADR-079: home задаёт плоскую раскладку (<home>/config.yaml) независимо от mode.
  const h = resolveHome(home);
  if (h) return join(h, 'config.yaml');

  const m = mode ?? resolveDeployMode();
  switch (m) {
    case 'user':   return join(homeDir(), '.config', 'synth', 'config.yaml');
    case 'dev':    return join(process.cwd(), 'config.yaml');
    default:       return '/etc/synth/config.yaml';
  }
}

export async function ensureConfigFile(targetPath: string): Promise<void> {
  if (existsSync(targetPath)) return;
  await mkdir(join(targetPath, '..'), { recursive: true });
  const yaml = dumpYaml(defaultConfig, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  await writeFile(targetPath, yaml, 'utf-8');
}

export async function ensureFirstRun(dataDirOverride?: string, configPathOverride?: string, home?: string | null): Promise<{ dataDir: string; configPath: string | null; mode: DeployMode }> {
  const mode = resolveDeployMode();
  // ADR-079: home задаёт плоскую раскладку (<home>/config.yaml, <home>/data).
  const h = resolveHome(home);

  // ADR-075: относительный --data-dir абсолютизируем на CLI-границе (иначе
  // containment-проверки FS получают относительный root и абсолютный target).
  const dataDir = resolve(dataDirOverride ?? resolveDataDir(defaultConfig, undefined, h));
  const configPath = configPathOverride ?? defaultConfigPath(mode, h);

  if (mode !== 'docker') {
    await ensureDataDir(dataDir);
  }

  if (mode !== 'docker' && configPath) {
    if (!existsSync(configPath)) {
      await ensureConfigFile(configPath);
    }
  }

  const foundPath = findConfigPath(h);

  if (mode === 'user' || mode === 'dev') {
    console.log(`  режим: ${mode}`);
    console.log(`  данные: ${dataDir}`);
    console.log(`  конфиг: ${foundPath || configPath}${existsSync(configPath) ? '' : ' (ещё не создан)'}`);
  }

  return { dataDir, configPath: foundPath || configPath, mode };
}

export function resolvePort(
  config: SynthConfig,
  envKey: string,
  configFallback: number,
  env?: NodeJS.ProcessEnv,
): number {
  const envVal = (env ?? process.env)[envKey];
  if (envVal) {
    const num = parseInt(envVal, 10);
    if (!isNaN(num)) return num;
  }
  return configFallback;
}

export function resolveWorkspacesRoot(config: SynthConfig, env?: NodeJS.ProcessEnv, home?: string | null): string {
  const envVal = (env ?? process.env).SYNTH_WORKSPACES_ROOT;
  if (envVal) return resolve(envVal);
  if (config.storage.workspacesRoot) return resolve(config.storage.workspacesRoot);
  const dataDir = resolveDataDir(config, env, home);
  return `${dataDir}/workspaces`;
}

export function resolveDefaultWorkspace(config: SynthConfig, env?: NodeJS.ProcessEnv, home?: string | null): string {
  const envVal = (env ?? process.env).SYNTH_DEFAULT_WORKSPACE;
  if (envVal) return resolve(envVal);
  if (config.storage.defaultWorkspace) return resolve(config.storage.defaultWorkspace);
  const dataDir = resolveDataDir(config, env, home);
  return join(dataDir, 'workspaces', 'default');
}

/**
 * ADR-079: путь к реестру профилей серверов. При заданном home — плоская
 * раскладка `<home>/profiles.json`, иначе XDG-дефолт `~/.config/synth/profiles.json`.
 */
export function resolveProfilesPath(home?: string | null): string {
  const h = resolveHome(home);
  if (h) return join(h, 'profiles.json');
  return join(homeDir(), '.config', 'synth', 'profiles.json');
}

/**
 * ADR-079: путь к файлу credentials. При заданном home — плоская раскладка
 * `<home>/credentials.json`, иначе XDG-дефолт `~/.config/synth/credentials.json`.
 */
export function resolveCredentialsPath(home?: string | null): string {
  const h = resolveHome(home);
  if (h) return join(h, 'credentials.json');
  return join(homeDir(), '.config', 'synth', 'credentials.json');
}

/**
 * ADR-075: эффективная политика для абсолютного workspace вне `workspacesRoot`
 * (приоритет: env `SYNTH_WORKSPACE_OUTSIDE_ROOT` > `config.storage.workspaceOutsideRoot` > `''`).
 * `''` — политика не задана; потребитель подставляет `confirm`.
 */
export function resolveWorkspaceOutsideRootPolicy(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): WorkspaceOutsideRootPolicy | '' {
  const envVal = (env ?? process.env).SYNTH_WORKSPACE_OUTSIDE_ROOT;
  if (envVal === 'confirm' || envVal === 'deny') return envVal;
  const cfgVal = config.storage.workspaceOutsideRoot;
  if (cfgVal === 'confirm' || cfgVal === 'deny') return cfgVal;
  return '';
}

/**
 * Максимальный размер загружаемого файла (`POST /api/v2/fs/upload`), в байтах.
 * Приоритет: env `SYNTH_MAX_UPLOAD_BYTES` > `config.storage.maxUploadBytes` >
 * `DEFAULT_MAX_UPLOAD_BYTES` (100 МиБ). Некорректное env-значение (не число или
 * вне границ `MIN_UPLOAD_BYTES`…`MAX_UPLOAD_BYTES_LIMIT`) — warn и фолбэк на
 * config/дефолт (fail-soft, как остальные env-резолверы; не падаем).
 */
export function resolveMaxUploadBytes(config: SynthConfig, env?: NodeJS.ProcessEnv): number {
  const raw = (env ?? process.env).SYNTH_MAX_UPLOAD_BYTES;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MIN_UPLOAD_BYTES && n <= MAX_UPLOAD_BYTES_LIMIT) {
      return Math.floor(n);
    }
    console.warn(
      `[config] невалидное значение SYNTH_MAX_UPLOAD_BYTES="${raw}" ` +
      `(ожидается число от ${MIN_UPLOAD_BYTES} до ${MAX_UPLOAD_BYTES_LIMIT}) — игнорируется`,
    );
  }
  return config.storage.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
}

/**
 * PROP-032: физический backend хранения. Приоритет (ADR-023): env
 * `SYNTH_STORAGE_BACKEND` > `config.storage.backend` > `'file'`. Некорректное
 * env-значение (не `file`/`memory`) — warn и фолбэк на config/дефолт
 * (fail-soft, как остальные env-резолверы).
 */
export function resolveStorageBackend(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): 'file' | 'memory' {
  const raw = (env ?? process.env).SYNTH_STORAGE_BACKEND;
  if (raw !== undefined && raw !== '') {
    if (raw === 'file' || raw === 'memory') return raw;
    console.warn(
      `[config] невалидное значение SYNTH_STORAGE_BACKEND="${raw}" ` +
      `(ожидается 'file' или 'memory') — игнорируется`,
    );
  }
  return config.storage.backend ?? 'file';
}

/**
 * ADR-076: мастер-ключ шифрования секретов at-rest (SSH-ключи, AES-256-GCM).
 * Приоритет: env `SYNTH_SECRET_KEY` > `config.security.secretKey` > `''`
 * (пусто — core использует файл `{dataDir}/secrets/master.key`).
 */
export function resolveSecretKey(config: SynthConfig, env?: NodeJS.ProcessEnv): string {
  const envVal = (env ?? process.env).SYNTH_SECRET_KEY;
  if (envVal) return envVal;
  if (config.security.secretKey) return config.security.secretKey;
  return '';
}

/**
 * ADR-069 §9.2: нейтральная сессия без проектных инструкций.
 * Приоритет: явный флаг CLI `--ignore-rules`/`--safe-mode` (`explicit`) >
 * env `SYNTH_IGNORE_RULES` (`1`/`true`). Значение — эффективный
 * `instructions.enabled=false`.
 */
export function resolveIgnoreRules(explicit?: boolean, env?: NodeJS.ProcessEnv): boolean {
  if (explicit) return true;
  const envVal = (env ?? process.env).SYNTH_IGNORE_RULES;
  return envVal === '1' || envVal?.toLowerCase() === 'true';
}

/**
 * ADR-084: имя decision-провайдера. Приоритет: env `SYNTH_DECISION_PROVIDER` >
 * `config.decision.provider`.
 *
 * Примечание: тот же env применяется и общим реестром `ENV_OVERRIDES` в
 * `loadConfig` (ADR-023, ключ `decision.provider`); резолвер сохранён для
 * потребителей, читающих конфиг не через `loadConfig`.
 */
export function resolveDecisionProvider(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): string {
  return (env ?? process.env).SYNTH_DECISION_PROVIDER || config.decision.provider;
}

/**
 * ADR-084: модель decision-слоя. Приоритет: env `SYNTH_DECISION_MODEL` >
 * `config.decision.model`.
 *
 * См. примечание к `resolveDecisionProvider` — env дублируется реестром
 * `ENV_OVERRIDES` (ADR-023).
 */
export function resolveDecisionModel(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): string {
  return (env ?? process.env).SYNTH_DECISION_MODEL || config.decision.model;
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  for (const subdir of DATA_SUBDIRS) {
    await mkdir(`${dataDir}/${subdir}`, { recursive: true });
  }
}

export async function createDefaultConfig(targetPath: string): Promise<void> {
  const yaml = dumpYaml(defaultConfig, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  await writeFile(targetPath, yaml, 'utf-8');
}

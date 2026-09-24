import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import type { SynthConfig } from './types.js';
import type { WorkspaceOutsideRootPolicy } from '../types/index.js';
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

export function resolveDataDir(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): string {
  const envVar = (env ?? process.env).SYNTH_DATA_DIR;
  if (envVar) return envVar;

  if (config.storage.dataDir && config.storage.dataDir !== defaultConfig.storage.dataDir) {
    return config.storage.dataDir;
  }

  const mode = resolveDeployMode();
  switch (mode) {
    case 'user':   return join(homeDir(), '.local', 'share', 'synth');
    case 'dev':    return join(process.cwd(), 'data');
    default:       return '/var/synth/data';
  }
}

export function findConfigPath(): string | null {
  const explicit = process.env.SYNTH_CONFIG;
  if (explicit) return explicit;

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

export function defaultConfigPath(mode?: DeployMode): string {
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

export async function ensureFirstRun(dataDirOverride?: string, configPathOverride?: string): Promise<{ dataDir: string; configPath: string | null; mode: DeployMode }> {
  const mode = resolveDeployMode();

  const dataDir = dataDirOverride ?? resolveDataDir(defaultConfig);
  const configPath = configPathOverride ?? defaultConfigPath(mode);

  if (mode !== 'docker') {
    await ensureDataDir(dataDir);
  }

  if (mode !== 'docker' && configPath) {
    if (!existsSync(configPath)) {
      await ensureConfigFile(configPath);
    }
  }

  const foundPath = findConfigPath();

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

export function resolveWorkspacesRoot(config: SynthConfig, env?: NodeJS.ProcessEnv): string {
  const envVal = (env ?? process.env).SYNTH_WORKSPACES_ROOT;
  if (envVal) return envVal;
  if (config.storage.workspacesRoot) return config.storage.workspacesRoot;
  const dataDir = resolveDataDir(config, env);
  return `${dataDir}/workspaces`;
}

export function resolveDefaultWorkspace(config: SynthConfig, env?: NodeJS.ProcessEnv): string {
  const envVal = (env ?? process.env).SYNTH_DEFAULT_WORKSPACE;
  if (envVal) return envVal;
  if (config.storage.defaultWorkspace) return config.storage.defaultWorkspace;
  const dataDir = resolveDataDir(config, env);
  return join(dataDir, 'workspaces', 'default');
}

/**
 * AD-075: эффективная политика для абсолютного workspace вне `workspacesRoot`
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

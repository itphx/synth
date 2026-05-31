import { mkdir, writeFile } from 'node:fs/promises';
import { dump as dumpYaml } from 'js-yaml';
import type { SynthConfig } from './types.js';
import { defaultConfig } from './defaults.js';

const DATA_SUBDIRS = [
  'sessions',
  'projects',
  'providers',
  'models',
  'agents',
  'context/user',
  'context/roles',
  'auth/profiles',
  'auth/sessions',
  'auth/states',
];

export function resolveDataDir(config: SynthConfig, env?: NodeJS.ProcessEnv): string {
  const envDir = env !== undefined ? env.SYNTH_DATA_DIR : process.env.SYNTH_DATA_DIR;
  return envDir || config.storage.dataDir;
}

export function resolvePort(
  config: SynthConfig,
  envKey: string,
  configFallback: number,
  env?: NodeJS.ProcessEnv,
): number {
  const envVal = env !== undefined ? env[envKey] : process.env[envKey];
  if (envVal) {
    const num = parseInt(envVal, 10);
    if (!isNaN(num)) return num;
  }
  return configFallback;
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

import { readFile } from 'node:fs/promises';
import { load as parseYaml } from 'js-yaml';
import { synthConfigSchema, type SynthConfig } from './types.js';
import { defaultConfig } from './defaults.js';
import { deepMerge } from './merge.js';

export interface LoadConfigOptions {
  configPath?: string;
  overrides?: Partial<SynthConfig>;
}

const CONFIG_SEARCH_PATHS = [
  'synth.config.yaml',
  'config.yaml',
];

const USER_CONFIG_DIR = '.config/synth';
const SYSTEM_CONFIG_PATH = '/etc/synth/config.yaml';

function searchPaths(explicitPath?: string): string[] {
  if (explicitPath) return [explicitPath];
  const paths: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // CWD
  for (const name of CONFIG_SEARCH_PATHS) {
    paths.push(name);
  }

  // ~/.config/synth/config.yaml
  if (home) {
    paths.push(`${home}/${USER_CONFIG_DIR}/config.yaml`);
  }

  // /etc/synth/config.yaml
  paths.push(SYSTEM_CONFIG_PATH);

  return paths;
}

async function tryReadYaml(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return parseYaml(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<SynthConfig> {
  const paths = searchPaths(options.configPath);

  let fileConfig: Record<string, unknown> = {};
  for (const path of paths) {
    const parsed = await tryReadYaml(path);
    if (parsed) {
      fileConfig = parsed;
      break;
    }
  }

  const merged = deepMerge(defaultConfig as unknown as Record<string, unknown>, fileConfig);
  const finalConfig = options.overrides
    ? deepMerge(merged, options.overrides as unknown as Record<string, unknown>)
    : merged;

  const parsed = synthConfigSchema.safeParse(finalConfig);
  if (!parsed.success) {
    throw new Error(`Невалидная конфигурация: ${parsed.error.message}`);
  }

  return parsed.data;
}

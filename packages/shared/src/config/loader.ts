import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { synthConfigSchema, type SynthConfig } from './types.js';
import { defaultConfig } from './defaults.js';
import { deepMerge } from './merge.js';
import { applyEnvOverrides, applyObjectEnvOverrides } from './env-overrides.js';

export interface LoadConfigOptions {
  configPath?: string;
  /** ADR-079: home-каталог — конфиг резолвится как `<home>/config.yaml`, если path не задан. */
  home?: string;
  overrides?: Partial<SynthConfig>;
  /** ADR-023: источник env для оверрайдов; по умолчанию `process.env` (в тестах — свой env). */
  env?: NodeJS.ProcessEnv;
}

const CONFIG_SEARCH_PATHS = [
  'synth.config.yaml',
  'config.yaml',
];

const USER_CONFIG_DIR = '.config/synth';
const SYSTEM_CONFIG_PATH = '/etc/synth/config.yaml';

function searchPaths(explicitPath?: string, home?: string): string[] {
  if (explicitPath) return [explicitPath];
  // ADR-079: при заданном home конфиг ищется строго в <home>/config.yaml
  // (home приоритетнее cwd/XDG-цепочки).
  if (home) return [join(home, 'config.yaml')];
  const paths: string[] = [];
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';

  // CWD
  for (const name of CONFIG_SEARCH_PATHS) {
    paths.push(name);
  }

  // ~/.config/synth/config.yaml
  if (homeDir) {
    paths.push(`${homeDir}/${USER_CONFIG_DIR}/config.yaml`);
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
  // ADR-023/ADR-071: явный путь — из опций, иначе из SYNTH_CONFIG (как в
  // findConfigPath). Без этого dev-запуск backend с cwd=synth/ не читал
  // packages/backend/config.yaml (mcp.servers) и seed реестра был пустым.
  const explicitPath = options.configPath ?? process.env.SYNTH_CONFIG;
  const paths = searchPaths(explicitPath, options.home);

  let fileConfig: Record<string, unknown> = {};
  for (const path of paths) {
    const parsed = await tryReadYaml(path);
    if (parsed) {
      fileConfig = parsed;
      break;
    }
  }

  const merged = deepMerge(defaultConfig as unknown as Record<string, unknown>, fileConfig);
  // ADR-023: env-оверрайды скалярных ключей вложенных секций применяются одним
  // местом — поверх defaults + config.yaml и ниже CLI-overrides
  // (приоритет: CLI > env > config.yaml > defaults).
  const withEnv = applyEnvOverrides(merged, options.env ?? process.env);
  // ADR-052/O1: объектный env-оверрайд installer service-key'ев
  // (`SYNTH_BOOTSTRAP_SERVICE_KEYS`, JSON) — там же, до CLI-overrides.
  applyObjectEnvOverrides(withEnv, options.env ?? process.env);
  const finalConfig = options.overrides
    ? deepMerge(withEnv, options.overrides as unknown as Record<string, unknown>)
    : withEnv;

  const parsed = synthConfigSchema.safeParse(finalConfig);
  if (!parsed.success) {
    throw new Error(`Невалидная конфигурация: ${parsed.error.message}`);
  }

  return parsed.data;
}

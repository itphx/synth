import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dump as dumpYaml } from 'js-yaml';
import type { PostgresStorageConfig, SynthConfig } from './types.js';
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
 * `SYNTH_STORAGE_BACKEND` > `config.storage.backend` > `'file'`.
 *
 * **Fail-closed**: если значение задано явно (env или config) и не входит в
 * поддерживаемый набор (`file`|`memory`|`postgres`) — бросаем ошибку с внятным
 * текстом (раньше был warn + тихий фоллбэк на `file`, что маскировало
 * опечатку и запускало инстанс не на том backend'е).
 */
export function resolveStorageBackend(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): StorageBackend {
  const raw = (env ?? process.env).SYNTH_STORAGE_BACKEND;
  if (raw !== undefined && raw !== '') {
    if (isStorageBackend(raw)) return raw;
    throw new Error(
      `[config] невалидное значение SYNTH_STORAGE_BACKEND="${raw}": ` +
        `ожидается одно из ${STORAGE_BACKENDS.map((b) => `'${b}'`).join(', ')}`,
    );
  }

  const cfg = config.storage.backend;
  if (cfg !== undefined) {
    if (isStorageBackend(cfg)) return cfg;
    throw new Error(
      `[config] невалидное значение storage.backend="${String(cfg)}": ` +
        `ожидается одно из ${STORAGE_BACKENDS.map((b) => `'${b}'`).join(', ')}`,
    );
  }

  return 'file';
}

/** Поддерживаемые физические backend'ы хранения (PROP-032). */
export type StorageBackend = 'file' | 'memory' | 'postgres';

const STORAGE_BACKENDS: readonly StorageBackend[] = ['file', 'memory', 'postgres'];

function isStorageBackend(value: unknown): value is StorageBackend {
  return typeof value === 'string' && (STORAGE_BACKENDS as readonly string[]).includes(value);
}

/** PROP-032: эффективные параметры PostgreSQL-backend (без пароля — инвариант 13). */
export interface ResolvedPostgresConfig {
  dsn?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  schema?: string;
  ssl?: boolean;
  poolMax?: number;
}

/**
 * PROP-032: параметры PostgreSQL-backend. Приоритет (ADR-023): env
 * (`SYNTH_POSTGRES_*`) > `config.storage.postgres`. **Пароль не включается**
 * (инвариант 13) — см. `resolvePostgresPassword`. Некорректное env-значение
 * (не число/булево) — warn и фолбэк на config (fail-soft, как прочие
 * env-резолверы).
 */
export function resolvePostgresConfig(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): ResolvedPostgresConfig {
  const e = env ?? process.env;
  const cfg: Partial<PostgresStorageConfig> = config.storage.postgres ?? {};
  const result: ResolvedPostgresConfig = {};

  const pickString = (envKey: string, cfgValue: string | undefined): string | undefined => {
    const envValue = e[envKey];
    if (envValue !== undefined && envValue !== '') return envValue;
    return cfgValue !== undefined && cfgValue !== '' ? cfgValue : undefined;
  };

  const dsn = pickString('SYNTH_POSTGRES_DSN', cfg.dsn);
  if (dsn !== undefined) result.dsn = dsn;
  const host = pickString('SYNTH_POSTGRES_HOST', cfg.host);
  if (host !== undefined) result.host = host;
  const database = pickString('SYNTH_POSTGRES_DATABASE', cfg.database);
  if (database !== undefined) result.database = database;
  const user = pickString('SYNTH_POSTGRES_USER', cfg.user);
  if (user !== undefined) result.user = user;
  const schema = pickString('SYNTH_POSTGRES_SCHEMA', cfg.schema);
  if (schema !== undefined) result.schema = schema;

  const port = resolvePositiveIntEnv(e.SYNTH_POSTGRES_PORT, cfg.port, 'SYNTH_POSTGRES_PORT');
  if (port !== undefined) result.port = port;
  const poolMax = resolvePositiveIntEnv(
    e.SYNTH_POSTGRES_POOL_MAX,
    cfg.poolMax,
    'SYNTH_POSTGRES_POOL_MAX',
  );
  if (poolMax !== undefined) result.poolMax = poolMax;

  const ssl = resolveBooleanEnv(e.SYNTH_POSTGRES_SSL, cfg.ssl, 'SYNTH_POSTGRES_SSL');
  if (ssl !== undefined) result.ssl = ssl;

  return result;
}

/** Парсит положительное целое из env; невалидно → warn + фолбэк на config. */
function resolvePositiveIntEnv(
  rawEnv: string | undefined,
  cfgValue: number | undefined,
  envName: string,
): number | undefined {
  if (rawEnv !== undefined && rawEnv !== '') {
    const n = Number(rawEnv);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
    console.warn(
      `[config] невалидное значение ${envName}="${rawEnv}" (ожидается целое > 0) — игнорируется`,
    );
  }
  return cfgValue;
}

/** Парсит булево из env (`true`/`1`/`false`/`0`); невалидно → warn + фолбэк на config. */
function resolveBooleanEnv(
  rawEnv: string | undefined,
  cfgValue: boolean | undefined,
  envName: string,
): boolean | undefined {
  if (rawEnv !== undefined && rawEnv !== '') {
    const v = rawEnv.toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    console.warn(
      `[config] невалидное значение ${envName}="${rawEnv}" (ожидается true/1/false/0) — игнорируется`,
    );
  }
  return cfgValue;
}

/**
 * PROP-032: пароль PostgreSQL. **Только** env `SYNTH_POSTGRES_PASSWORD` →
 * файл `{dataDir}/secrets/postgres-password` (инвариант 13: в config.yaml
 * секретов нет). Файла нет — `undefined` (решение об ошибке принимает драйвер:
 * для peer/trust-аутентификации пароль не нужен). Читается только, не создаётся.
 */
export function resolvePostgresPassword(
  opts: { dataDir: string },
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const envValue = (env ?? process.env).SYNTH_POSTGRES_PASSWORD;
  if (envValue) return envValue;

  const file = join(opts.dataDir, 'secrets', 'postgres-password');
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf-8').trim();
    return raw.length > 0 ? raw : undefined;
  }
  return undefined;
}

/** PROP-032 (W5): допустимые политики при недоступности backend'а. */
const DEGRADED_MODES: readonly ('fallback-file' | 'halt')[] = ['fallback-file', 'halt'];

function isDegradedMode(value: unknown): value is 'fallback-file' | 'halt' {
  return typeof value === 'string' && (DEGRADED_MODES as readonly string[]).includes(value);
}

/**
 * PROP-032 (W5): политика при недоступности выбранного backend —
 * `fallback-file` (default) | `halt`. Читать через этот резолвер.
 *
 * Приоритет (ADR-023): env `SYNTH_DEGRADED_MODE` > `config.storage.degradedMode` >
 * `fallback-file`. Невалидное env-значение — warn и фолбэк на config (fail-soft,
 * как прочие env-резолверы storage-секции `SYNTH_STORAGE_BACKEND`/`SYNTH_POSTGRES_*`).
 */
export function resolveDegradedMode(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
): 'fallback-file' | 'halt' {
  const raw = (env ?? process.env).SYNTH_DEGRADED_MODE;
  if (raw !== undefined && raw !== '') {
    if (isDegradedMode(raw)) return raw;
    console.warn(
      `[config] невалидное значение SYNTH_DEGRADED_MODE="${raw}" ` +
        `(ожидается ${DEGRADED_MODES.map((m) => `'${m}'`).join(' | ')}) — игнорируется`,
    );
  }
  return config.storage.degradedMode ?? 'fallback-file';
}

/**
 * PROP-032 (W5): каталог файлового фоллбека. Приоритет (ADR-023): env
 * `SYNTH_STORAGE_FALLBACK_DIR` > явный `config.storage.fallbackDir` → `''`
 * (эффективно `{dataDir}/fallback`).
 */
export function resolveStorageFallbackDir(
  config: SynthConfig,
  env?: NodeJS.ProcessEnv,
  home?: string | null,
): string {
  const envVal = (env ?? process.env).SYNTH_STORAGE_FALLBACK_DIR;
  if (envVal) return resolve(envVal);
  if (config.storage.fallbackDir) return resolve(config.storage.fallbackDir);
  return join(resolveDataDir(config, env, home), 'fallback');
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

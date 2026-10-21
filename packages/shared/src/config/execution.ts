/**
 * PROP-077: резолвер секции `execution` — топология исполнения.
 *
 * Секция — **параметр запуска** (не runtime-настройка): смена `mode` — только
 * рестартом процесса (инвариант 24). Приоритет (ADR-023):
 * **CLI-флаг > env > config.yaml > дефолт**.
 *
 * Env-имена (ровно эти — как зафиксировано в PROP-077):
 * `SYNTH_EXECUTION_MODE`, `SYNTH_EXECUTION_REMOTE_URL`, `SYNTH_EXECUTION_TOKEN`,
 * `SYNTH_EXECUTION_TIMEOUT_MS`, `SYNTH_EXECUTION_CONCURRENCY`,
 * `SYNTH_EXECUTION_FAIL_MODE`.
 *
 * Fail-closed (как `storage.backend`): неизвестное **явное** значение `mode`
 * (опечатка `inlne`) или `failMode` — ошибка, а не тихий выбор дефолта.
 */
import { availableParallelism, cpus } from 'node:os';
import type { SynthConfig } from './types.js';
import {
  DEFAULT_EXECUTION_TIMEOUT_MS,
  EXECUTION_FAIL_MODES,
  EXECUTION_MODES,
  type ExecutionFailMode,
  type ExecutionMode,
} from './types.js';

/** Env-имена секции `execution` (PROP-077). */
export const EXECUTION_ENV = {
  mode: 'SYNTH_EXECUTION_MODE',
  remoteUrl: 'SYNTH_EXECUTION_REMOTE_URL',
  token: 'SYNTH_EXECUTION_TOKEN',
  timeoutMs: 'SYNTH_EXECUTION_TIMEOUT_MS',
  concurrency: 'SYNTH_EXECUTION_CONCURRENCY',
  failMode: 'SYNTH_EXECUTION_FAIL_MODE',
} as const;

/** Имя CLI-флага переключателя топологии (`synth serve --execution-mode`). */
export const EXECUTION_MODE_CLI_FLAG = '--execution-mode';

/**
 * Лимит одновременных exec-вызовов по умолчанию — число CPU процесса.
 * `availableParallelism()` (Node 18.14+) учитывает cgroup/affinity; фолбэк —
 * `os.cpus().length`.
 */
export function defaultExecutionConcurrency(): number {
  const n =
    typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Math.max(1, n);
}

/** Эффективные параметры удалённого исполнителя. */
export interface ResolvedExecutionRemoteConfig {
  /** Список адресов исполнителей (пусто — при `remote` fail-closed на старте). */
  url: string[];
  /** Таймаут exec-вызова, мс. */
  timeoutMs: number;
  /** Лимит одновременных exec-вызовов. */
  concurrency: number;
  /** Поведение при недоступном исполнителе. */
  failMode: ExecutionFailMode;
  /** Путь/ссылка на токен исполнителя (НЕ значение — инвариант 13). */
  tokenSecret: string;
}

/** Эффективная секция `execution`. */
export interface ResolvedExecutionConfig {
  /** Топология исполнения. */
  mode: ExecutionMode;
  remote: ResolvedExecutionRemoteConfig;
}

/** Явное значение CLI-флага (приоритетнее env и config.yaml). */
export interface ExecutionCliOverride {
  mode?: string | null;
}

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}

export function isExecutionFailMode(value: unknown): value is ExecutionFailMode {
  return (
    typeof value === 'string' && (EXECUTION_FAIL_MODES as readonly string[]).includes(value)
  );
}

/**
 * Разбор списка адресов исполнителей: строка через запятую (`a, b`) — как у
 * прочих списков конфигурации (`proxy.noProxy`). Пустые элементы отбрасываются.
 */
export function parseExecutionUrlList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function invalidModeMessage(source: string, value: string): string {
  return (
    `[config] невалидное значение ${source}="${value}": ` +
    `ожидается одно из ${EXECUTION_MODES.map((m) => `'${m}'`).join(', ')}`
  );
}

function invalidFailModeMessage(source: string, value: string): string {
  return (
    `[config] невалидное значение ${source}="${value}": ` +
    `ожидается одно из ${EXECUTION_FAIL_MODES.map((m) => `'${m}'`).join(', ')}`
  );
}

/**
 * Резолвит режим исполнения. Приоритет: CLI-флаг > env `SYNTH_EXECUTION_MODE` >
 * `config.execution.mode` > `inline`.
 *
 * **Fail-closed**: неизвестное явно заданное значение — ошибка (опечатка `inlne`
 * не должна молча оставить инстанс в inline-режиме).
 */
export function resolveExecutionMode(
  config: SynthConfig,
  env: NodeJS.ProcessEnv = process.env,
  cli?: ExecutionCliOverride,
): ExecutionMode {
  const cliMode = cli?.mode;
  if (cliMode !== undefined && cliMode !== null && String(cliMode).trim() !== '') {
    const raw = String(cliMode).trim();
    if (isExecutionMode(raw)) return raw;
    throw new Error(invalidModeMessage(EXECUTION_MODE_CLI_FLAG, raw));
  }

  const envMode = env[EXECUTION_ENV.mode];
  if (envMode !== undefined && envMode !== '') {
    const raw = envMode.trim();
    if (isExecutionMode(raw)) return raw;
    throw new Error(invalidModeMessage(EXECUTION_ENV.mode, envMode));
  }

  const cfgMode = config.execution?.mode;
  if (cfgMode !== undefined) {
    if (isExecutionMode(cfgMode)) return cfgMode;
    throw new Error(invalidModeMessage('execution.mode', String(cfgMode)));
  }

  return 'inline';
}

/**
 * Резолвит секцию `execution` целиком (PROP-077).
 *
 * Приоритет (ADR-023): CLI-флаг (`--execution-mode`) > env `SYNTH_EXECUTION_*` >
 * `config.execution.*` > дефолты. Нечисловые env-значения — warn и фолбэк на
 * config/дефолт (fail-soft, как прочие числовые env-резолверы); неизвестные
 * `mode`/`failMode` — **fail-closed** (ошибка).
 */
export function resolveExecutionConfig(
  config: SynthConfig,
  env: NodeJS.ProcessEnv = process.env,
  cli?: ExecutionCliOverride,
): ResolvedExecutionConfig {
  const mode = resolveExecutionMode(config, env, cli);

  const remoteCfg = config.execution?.remote ?? {};

  // Адреса исполнителей: env (список через запятую) > config.yaml > [].
  const rawUrl = env[EXECUTION_ENV.remoteUrl];
  const url =
    rawUrl !== undefined && rawUrl !== ''
      ? parseExecutionUrlList(rawUrl)
      : [...(remoteCfg.url ?? [])];

  // Таймаут exec-вызова: env > config.yaml > дефолт (30 с).
  const timeoutMs = resolvePositiveInt(
    env[EXECUTION_ENV.timeoutMs],
    remoteCfg.timeoutMs,
    EXECUTION_ENV.timeoutMs,
  ) ?? DEFAULT_EXECUTION_TIMEOUT_MS;

  // Лимит одновременных вызовов: env > config.yaml > число CPU процесса.
  const concurrency =
    resolvePositiveInt(
      env[EXECUTION_ENV.concurrency],
      remoteCfg.concurrency,
      EXECUTION_ENV.concurrency,
    ) ?? defaultExecutionConcurrency();

  // Поведение при недоступности исполнителя: env > config.yaml > `fail`.
  const failMode = resolveFailMode(remoteCfg.failMode, env);

  // Токен исполнителя: env > config.yaml > '' (путь/ссылка, НЕ значение).
  const tokenEnv = env[EXECUTION_ENV.token];
  const tokenSecret =
    tokenEnv !== undefined && tokenEnv !== '' ? tokenEnv : (remoteCfg.tokenSecret ?? '');

  return {
    mode,
    remote: { url, timeoutMs, concurrency, failMode, tokenSecret },
  };
}

function resolveFailMode(
  cfgValue: ExecutionFailMode | undefined,
  env: NodeJS.ProcessEnv,
): ExecutionFailMode {
  const raw = env[EXECUTION_ENV.failMode];
  if (raw !== undefined && raw !== '') {
    const trimmed = raw.trim();
    if (isExecutionFailMode(trimmed)) return trimmed;
    throw new Error(invalidFailModeMessage(EXECUTION_ENV.failMode, raw));
  }
  if (cfgValue !== undefined) {
    if (isExecutionFailMode(cfgValue)) return cfgValue;
    throw new Error(invalidFailModeMessage('execution.remote.failMode', String(cfgValue)));
  }
  return 'fail';
}

/** Положительное целое из env; невалидно — warn и фолбэк на config (fail-soft). */
function resolvePositiveInt(
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

/**
 * Конфигурация исполнителя из env (ADR-077, шаг 7a).
 *
 * Исполнитель — отдельный процесс, поэтому конфигурация — **только env**
 * (никакого config.yaml: у воркера нет доступа к каталогу данных инстанса).
 *
 * Env-имена:
 *
 * | Переменная | Обязательна | По умолчанию | Назначение |
 * |---|---|---|---|
 * | `SYNTH_EXECUTOR_TOKEN` | **да** | — | bearer-токен доступа к API исполнителя |
 * | `SYNTH_EXECUTOR_WORKSPACE` | **да** | — | корень workspace (граница containment'а) |
 * | `SYNTH_EXECUTOR_HOST` | нет | `0.0.0.0` | адрес прослушивания |
 * | `SYNTH_EXECUTOR_PORT` | нет | `5100` | порт прослушивания |
 * | `SYNTH_EXECUTOR_MAX_CONCURRENCY` | нет | `4` | лимит одновременных команд |
 * | `SYNTH_EXECUTOR_MAX_TIMEOUT_MS` | нет | `120000` | потолок таймаута команды |
 * | `SYNTH_EXECUTOR_MAX_OUTPUT_BYTES` | нет | `10485760` | потолок буфера вывода |
 *
 * **Fail-closed**: без токена или без корня workspace процесс не стартует —
 * исполнитель без аутентификации или без границы рабочего каталога опаснее,
 * чем отсутствие исполнителя (ADR-077 §безопасность). Нечисловые значения —
 * тоже ошибка (явная настройка оператора не должна молча превращаться в дефолт).
 *
 * Токен читается из env **один раз** при старте и удаляется из `process.env`
 * (см. `scrubExecutorToken`): иначе он попадёт в окружение дочерних процессов
 * и утечёт в текст команды, который видит модель.
 */

import { EXECUTOR_PROTOCOL_VERSION } from './protocol.js';

/** Env-имена исполнителя. */
export const EXECUTOR_ENV = {
  host: 'SYNTH_EXECUTOR_HOST',
  port: 'SYNTH_EXECUTOR_PORT',
  token: 'SYNTH_EXECUTOR_TOKEN',
  workspace: 'SYNTH_EXECUTOR_WORKSPACE',
  maxConcurrency: 'SYNTH_EXECUTOR_MAX_CONCURRENCY',
  maxTimeoutMs: 'SYNTH_EXECUTOR_MAX_TIMEOUT_MS',
  maxOutputBytes: 'SYNTH_EXECUTOR_MAX_OUTPUT_BYTES',
} as const;

/** Дефолты исполнителя. */
export const EXECUTOR_DEFAULTS = {
  host: '0.0.0.0',
  port: 5100,
  maxConcurrency: 4,
  maxTimeoutMs: 120_000,
  maxOutputBytes: 10 * 1024 * 1024,
} as const;

/** Эффективная конфигурация исполнителя. */
export interface ExecutorConfig {
  /** Адрес прослушивания. */
  host: string;
  /** Порт прослушивания. */
  port: number;
  /** Bearer-токен доступа к API исполнителя (в логи не пишется). */
  token: string;
  /** Корень workspace — граница containment'а для `cwd`. */
  workspaceRoot: string;
  /** Лимит одновременных команд. */
  maxConcurrency: number;
  /** Потолок таймаута команды, мс. */
  maxTimeoutMs: number;
  /** Потолок буфера вывода, байт. */
  maxOutputBytes: number;
}

function requireEnvString(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `[executor] обязательная переменная ${name} не задана — исполнитель не стартует (fail-closed)`,
    );
  }
  return raw.trim();
}

function requirePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `[executor] невалидное значение ${name}="${raw}" — ожидается целое число > 0`,
    );
  }
  return value;
}

/**
 * Разбор конфигурации исполнителя из env.
 *
 * @throws Error при отсутствии обязательных переменных или невалидных значениях.
 */
export function resolveExecutorConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const host = env[EXECUTOR_ENV.host]?.trim() || EXECUTOR_DEFAULTS.host;
  const port = requirePositiveInt(env, EXECUTOR_ENV.port, EXECUTOR_DEFAULTS.port);
  if (port > 65_535) {
    throw new Error(`[executor] невалидное значение ${EXECUTOR_ENV.port}="${port}" — порт вне 1..65535`);
  }
  return {
    host,
    port,
    token: requireEnvString(env, EXECUTOR_ENV.token),
    workspaceRoot: requireEnvString(env, EXECUTOR_ENV.workspace),
    maxConcurrency: requirePositiveInt(
      env,
      EXECUTOR_ENV.maxConcurrency,
      EXECUTOR_DEFAULTS.maxConcurrency,
    ),
    maxTimeoutMs: requirePositiveInt(
      env,
      EXECUTOR_ENV.maxTimeoutMs,
      EXECUTOR_DEFAULTS.maxTimeoutMs,
    ),
    maxOutputBytes: requirePositiveInt(
      env,
      EXECUTOR_ENV.maxOutputBytes,
      EXECUTOR_DEFAULTS.maxOutputBytes,
    ),
  };
}

/**
 * Убрать токен из `process.env`, чтобы он не утек в окружение дочерних
 * процессов (команда агента видит `env` своего процесса).
 *
 * Вызывается **после** чтения конфигурации; значение остаётся только в памяти
 * процесса (в `ExecutorConfig.token`).
 */
export function scrubExecutorToken(env: NodeJS.ProcessEnv = process.env): void {
  delete env[EXECUTOR_ENV.token];
}

/** Версия wire-протокола (в ответе `/capabilities` и `/health`). */
export const EXECUTOR_VERSION = EXECUTOR_PROTOCOL_VERSION;

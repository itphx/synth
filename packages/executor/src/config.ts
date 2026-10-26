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
 * | `SYNTH_EXECUTOR_MCP_SERVERS` | нет | `[]` | MCP-серверы, которые исполнитель хостит у себя (JSON-массив) |
 * | `SYNTH_EXECUTOR_BACKGROUND_MAX` | нет | `8` | лимит живых фоновых процессов (ADR-077, шаг 7c) |
 * | `SYNTH_EXECUTOR_BACKGROUND_LOG_MAX_BYTES` | нет | `10485760` | лимит журнала фонового процесса на поток, байт |
 * | `SYNTH_EXECUTOR_BACKGROUND_LOG_DIR` | нет | `<tmp>/synth-exec-bg` | каталог журналов фоновых процессов |
 * | `SYNTH_EXECUTOR_METRICS_ENABLED` | нет | `false` | экспорт метрик исполнителя (`GET /metrics`) |
 * | `SYNTH_EXECUTOR_TLS_CA_FILE` | нет | — | файл CA доверия git (`http.sslCAInfo`); путь в окружении исполнителя |
 *
 * **Fail-closed**: без токена или без корня workspace процесс не стартует —
 * исполнитель без аутентификации или без границы рабочего каталога опаснее,
 * чем отсутствие исполнителя (ADR-077 §безопасность). Нечисловые значения —
 * тоже ошибка (явная настройка оператора не должна молча превращаться в дефолт).
 * `SYNTH_EXECUTOR_MCP_SERVERS` разбирается **строго**: невалидный JSON или
 * невалидное описание сервера — тоже ошибка старта (иначе оператор посчитал бы
 * серверы поднятыми, а они не поднялись). **Пустая строка — это «серверов
 * нет»**, а не ошибка: так отключается дефолт из образа (`ENV` во flavor'ах с
 * браузером, см. `docker/Dockerfile.executor`).
 *
 * `SYNTH_EXECUTOR_TLS_CA_FILE` — **конфигурация** доверия, а не пользовательский
 * секрет (ADR-077, «Обновлено 2026-10-26», (в)): задан, но файл не читается —
 * **ошибка старта** (fail-closed). Иначе исполнитель считал бы, что доверяет
 * CA, а на деле git-команды падали бы с невнятной ошибкой TLS.
 *
 * Токен читается из env **один раз** при старте и удаляется из `process.env`
 * (см. `scrubExecutorToken`): иначе он попадёт в окружение дочерних процессов
 * и утечёт в текст команды, который видит модель. Так же вычищается
 * `SYNTH_EXECUTOR_MCP_SERVERS` (в нём могут быть токены MCP-серверов) —
 * см. `scrubExecutorMcpServers`.
 */

import { accessSync, constants } from 'node:fs';
import { EXECUTOR_PROTOCOL_VERSION } from './protocol.js';
import type { McpServerSpec } from './mcp.js';

/** Env-имена исполнителя. */
export const EXECUTOR_ENV = {
  host: 'SYNTH_EXECUTOR_HOST',
  port: 'SYNTH_EXECUTOR_PORT',
  token: 'SYNTH_EXECUTOR_TOKEN',
  workspace: 'SYNTH_EXECUTOR_WORKSPACE',
  maxConcurrency: 'SYNTH_EXECUTOR_MAX_CONCURRENCY',
  maxTimeoutMs: 'SYNTH_EXECUTOR_MAX_TIMEOUT_MS',
  maxOutputBytes: 'SYNTH_EXECUTOR_MAX_OUTPUT_BYTES',
  mcpServers: 'SYNTH_EXECUTOR_MCP_SERVERS',
  backgroundMax: 'SYNTH_EXECUTOR_BACKGROUND_MAX',
  backgroundLogMaxBytes: 'SYNTH_EXECUTOR_BACKGROUND_LOG_MAX_BYTES',
  backgroundLogDir: 'SYNTH_EXECUTOR_BACKGROUND_LOG_DIR',
  metricsEnabled: 'SYNTH_EXECUTOR_METRICS_ENABLED',
  tlsCaFile: 'SYNTH_EXECUTOR_TLS_CA_FILE',
} as const;

/** Дефолты исполнителя. */
export const EXECUTOR_DEFAULTS = {
  host: '0.0.0.0',
  port: 5100,
  maxConcurrency: 4,
  maxTimeoutMs: 120_000,
  maxOutputBytes: 10 * 1024 * 1024,
  backgroundMax: 8,
  backgroundLogMaxBytes: 10 * 1024 * 1024,
  /** ADR-094: метрики исполнителя выключены по умолчанию (`/metrics` → 404). */
  metricsEnabled: false,
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
  /** Лимит живых фоновых процессов (ADR-077, шаг 7c). */
  backgroundMax: number;
  /** Лимит журнала фонового процесса на поток, байт. */
  backgroundLogMaxBytes: number;
  /** Каталог журналов фоновых процессов (не задан — дефолт сервиса). */
  backgroundLogDir?: string;
  /**
   * ADR-094: включён ли экспорт метрик исполнителя (`GET /metrics`).
   * По умолчанию — выключено (эндпоинт отвечает 404).
   */
  metricsEnabled: boolean;
  /** MCP-серверы, которые исполнитель хостит у себя (stdio). */
  mcpServers: McpServerSpec[];
  /**
   * Файл CA доверия git (`http.sslCAInfo`) — путь в окружении исполнителя.
   * Задан → исполнитель добавляет его в окружение вызова (ADR-077/ADR-099).
   */
  tlsCaFile?: string;
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
 * Разбор пути к файлу CA доверия (ADR-077, «Обновлено 2026-10-26», (в)).
 *
 * CA — **конфигурация** исполнителя, а не пользовательский секрет: путь
 * задаётся при старте, читаемость проверяется сразу. Задан, но файл не
 * читается — **ошибка старта** (fail-closed): иначе исполнитель считал бы,
 * что доверяет CA, а git-команды падали бы с невнятной ошибкой TLS.
 *
 * @param raw значение env (пустое/незаданное — CA не задан)
 * @param envName имя переменной (для понятного текста ошибки)
 */
export function resolveTlsCaFile(raw: string | undefined, envName: string): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    accessSync(trimmed, constants.R_OK);
  } catch {
    throw new Error(
      `[executor] ${envName}="${trimmed}" — файл CA недоступен для чтения (исполнитель не стартует, fail-closed)`,
    );
  }
  return trimmed;
}

/**
 * Разбор булева значения env (строгий).
 *
 * Допустимы только `true`/`false` (в любом регистре) и `1`/`0`. Невалидное
 * значение — **ошибка старта**: молчаливый переход в `false` означал бы, что
 * оператор включил метрики, а они молча не работают (или наоборот).
 *
 * @param raw значение env (пустое/незаданное — дефолт)
 * @param envName имя переменной (для понятного текста ошибки)
 * @param fallback значение по умолчанию
 */
export function resolveBooleanEnv(
  raw: string | undefined,
  envName: string,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const normalized = trimmed.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(
    `[executor] невалидное значение ${envName}="${raw}" — ожидается true/false (или 1/0)`,
  );
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
    backgroundMax: requirePositiveInt(
      env,
      EXECUTOR_ENV.backgroundMax,
      EXECUTOR_DEFAULTS.backgroundMax,
    ),
    backgroundLogMaxBytes: requirePositiveInt(
      env,
      EXECUTOR_ENV.backgroundLogMaxBytes,
      EXECUTOR_DEFAULTS.backgroundLogMaxBytes,
    ),
    backgroundLogDir: env[EXECUTOR_ENV.backgroundLogDir]?.trim() || undefined,
    metricsEnabled: resolveBooleanEnv(
      env[EXECUTOR_ENV.metricsEnabled],
      EXECUTOR_ENV.metricsEnabled,
      EXECUTOR_DEFAULTS.metricsEnabled,
    ),
    mcpServers: parseMcpServerSpecs(env[EXECUTOR_ENV.mcpServers], EXECUTOR_ENV.mcpServers),
    tlsCaFile: resolveTlsCaFile(env[EXECUTOR_ENV.tlsCaFile], EXECUTOR_ENV.tlsCaFile),
  };
}

/**
 * Разбор описаний MCP-серверов исполнителя (JSON-массив в env).
 *
 * Формат:
 *
 * ```json
 * [{"name":"playwright-mcp","command":"playwright-mcp","args":["--no-sandbox"],"env":{}}]
 * ```
 *
 * Разбор **строгий**: невалидный JSON, не-массив, не-объект, отсутствующие
 * `name`/`command`, не-строковые `args`/`env` или повторяющиеся имена — ошибка
 * (fail-closed при старте). Молчаливый пропуск сломанной записи означал бы,
 * что оператор считает серверы поднятыми, а они не поднялись.
 *
 * Значения `env` — секреты (токены хостингов): они не логируются и не
 * возвращаются в ответах API (см. `mcp.ts`).
 *
 * @param raw значение env (пустое/незаданное — ни одного сервера)
 * @param envName имя переменной (для понятного текста ошибки)
 * @throws Error при невалидном значении
 */
export function parseMcpServerSpecs(raw: string | undefined, envName: string): McpServerSpec[] {
  if (raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `[executor] невалидный JSON в ${envName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`[executor] ${envName} должен быть JSON-массивом описаний MCP-серверов`);
  }

  const specs: McpServerSpec[] = [];
  const names = new Set<string>();
  parsed.forEach((item, index) => {
    const where = `${envName}[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`[executor] ${where}: описание MCP-сервера должно быть объектом`);
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name.length === 0) {
      throw new Error(`[executor] ${where}: обязательное поле name (имя MCP-сервера)`);
    }
    if (names.has(name)) {
      throw new Error(`[executor] ${where}: имя MCP-сервера "${name}" уже используется`);
    }
    names.add(name);
    const command = typeof record.command === 'string' ? record.command.trim() : '';
    if (command.length === 0) {
      throw new Error(`[executor] ${where} ("${name}"): обязательное поле command (команда запуска)`);
    }
    let args: string[] = [];
    if (record.args !== undefined) {
      if (!Array.isArray(record.args) || !record.args.every((arg) => typeof arg === 'string')) {
        throw new Error(`[executor] ${where} ("${name}"): поле args должно быть массивом строк`);
      }
      args = [...(record.args as string[])];
    }
    const env: Record<string, string> = {};
    if (record.env !== undefined) {
      if (typeof record.env !== 'object' || record.env === null || Array.isArray(record.env)) {
        throw new Error(`[executor] ${where} ("${name}"): поле env должно быть объектом`);
      }
      for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new Error(`[executor] ${where} ("${name}"): env.${key} должно быть строкой`);
        }
        env[key] = value;
      }
    }
    specs.push({ name, command, args, env });
  });

  return specs;
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

/**
 * Убрать описание MCP-серверов из `process.env`.
 *
 * В `SYNTH_EXECUTOR_MCP_SERVERS` могут быть **токены** MCP-серверов (например,
 * `GITHUB_PERSONAL_ACCESS_TOKEN`). Если оставить переменную в окружении
 * процесса, её увидит любая агентская команда (`env`, `printenv`) — то есть
 * модель. Значения остаются в памяти (в `ExecutorConfig.mcpServers`) и
 * передаются MCP-серверам **явно** при спавне.
 */
export function scrubExecutorMcpServers(env: NodeJS.ProcessEnv = process.env): void {
  delete env[EXECUTOR_ENV.mcpServers];
}

/** Версия wire-протокола (в ответе `/capabilities` и `/health`). */
export const EXECUTOR_VERSION = EXECUTOR_PROTOCOL_VERSION;

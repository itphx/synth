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
 * | `SYNTH_EXECUTOR_MAX_TIMEOUT_MS` | нет | `600000` | потолок таймаута команды |
 * | `SYNTH_EXECUTOR_MAX_OUTPUT_BYTES` | нет | `10485760` | потолок буфера вывода |
 * | `SYNTH_EXECUTOR_MCP_SERVERS` | нет | `[]` | MCP-серверы, которые исполнитель хостит у себя (JSON-массив) |
 * | `SYNTH_EXECUTOR_BACKGROUND_MAX` | нет | `8` | лимит живых фоновых процессов (ADR-077, шаг 7c) |
 * | `SYNTH_EXECUTOR_BACKGROUND_LOG_MAX_BYTES` | нет | `10485760` | лимит журнала фонового процесса на поток, байт |
 * | `SYNTH_EXECUTOR_BACKGROUND_LOG_DIR` | нет | `<tmp>/synth-exec-bg` | каталог журналов фоновых процессов |
 * | `SYNTH_EXECUTOR_METRICS_ENABLED` | нет | `false` | экспорт метрик исполнителя (`GET /metrics`) |
 * | `SYNTH_EXECUTOR_TLS_CA_FILE` | нет | — | файл CA доверия git (`http.sslCAInfo`); путь в окружении исполнителя |
 * | `SYNTH_EXECUTOR_COMMAND_POLICY_PROVIDER` | нет | `off` | внешний чекер команд (PROP-136b): `off`\|`http`\|`opa` |
 * | `SYNTH_EXECUTOR_COMMAND_POLICY_URL` | при `http`/`opa` | — | адрес чекера (`http(s)://…`), без завершающего слэша |
 * | `SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE` | нет | — | файл bearer-токена чекера; пусто — без авторизации |
 * | `SYNTH_EXECUTOR_COMMAND_POLICY_FAIL_MODE` | нет | `closed` | поведение при недоступном чекере: `closed`\|`open` |
 * | `SYNTH_EXECUTOR_COMMAND_POLICY_TIMEOUT_MS` | нет | `2000` | таймаут запроса к чекеру, мс (обязателен) |
 * | `SYNTH_EXECUTOR_COMMAND_POLICY_CACHE_TTL_MS` | нет | `60000` | TTL кэша вердиктов, мс (`0` — без кэша) |
 * | `SYNTH_EXECUTOR_COMMAND_POLICY_OPA_PATH` | нет | `/v1/data/synth/exec/decision` | путь OPA-решения при `provider: opa` |
 * | `SYNTH_EXECUTOR_PTY` | нет | `1` | включён ли контур PTY-сессий (протокол 8) |
 * | `SYNTH_EXECUTOR_PTY_MAX` | нет | `4` | лимит живых PTY-сессий исполнителя |
 * | `SYNTH_EXECUTOR_PTY_IDLE_MS` | нет | `172800000` | таймаут простоя PTY-сессии, мс (2 дня) — idle-reaper закрывает зависшие терминалы |
 * | `SYNTH_EXECUTOR_PTY_INPUT_MAX_BYTES` | нет | `16384` | потолок тела ввода PTY, байт |
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
 *
 * **Внешний чекер команд (PROP-136b).** `SYNTH_EXECUTOR_COMMAND_POLICY_*` —
 * конфигурация чекера, который решает `allow`/`deny` **до** запуска команды.
 * Значение токена в env/конфиге не хранится: `..._TOKEN_FILE` — только путь,
 * сам токен читает `createCommandPolicyGuard` при старте (`command-policy.ts`)
 * и держит в памяти процесса; путь задан, но файл не читается — **ошибка
 * старта** (fail-closed: иначе проверка молча шла бы без авторизации).
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
  commandPolicyProvider: 'SYNTH_EXECUTOR_COMMAND_POLICY_PROVIDER',
  commandPolicyUrl: 'SYNTH_EXECUTOR_COMMAND_POLICY_URL',
  commandPolicyTokenFile: 'SYNTH_EXECUTOR_COMMAND_POLICY_TOKEN_FILE',
  commandPolicyFailMode: 'SYNTH_EXECUTOR_COMMAND_POLICY_FAIL_MODE',
  commandPolicyTimeoutMs: 'SYNTH_EXECUTOR_COMMAND_POLICY_TIMEOUT_MS',
  commandPolicyCacheTtlMs: 'SYNTH_EXECUTOR_COMMAND_POLICY_CACHE_TTL_MS',
  commandPolicyOpaPath: 'SYNTH_EXECUTOR_COMMAND_POLICY_OPA_PATH',
  pty: 'SYNTH_EXECUTOR_PTY',
  ptyMax: 'SYNTH_EXECUTOR_PTY_MAX',
  ptyIdleMs: 'SYNTH_EXECUTOR_PTY_IDLE_MS',
  ptyInputMaxBytes: 'SYNTH_EXECUTOR_PTY_INPUT_MAX_BYTES',
} as const;

/** Дефолты исполнителя. */
export const EXECUTOR_DEFAULTS = {
  host: '0.0.0.0',
  port: 5100,
  maxConcurrency: 4,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 10 * 1024 * 1024,
  backgroundMax: 8,
  backgroundLogMaxBytes: 10 * 1024 * 1024,
  /** ADR-094: метрики исполнителя выключены по умолчанию (`/metrics` → 404). */
  metricsEnabled: false,
  /** PROP-136b: чекер команд по умолчанию выключен (enforcement'а нет). */
  commandPolicyProvider: 'off',
  /** PROP-136b: недоступен чекер — команда **не** исполняется (fail-closed). */
  commandPolicyFailMode: 'closed',
  commandPolicyTimeoutMs: 2_000,
  commandPolicyCacheTtlMs: 60_000,
  commandPolicyOpaPath: '/v1/data/synth/exec/decision',
  /** Протокол 8: PTY-контур включён по умолчанию. */
  ptyEnabled: true,
  /** Протокол 8: лимит живых PTY-сессий. */
  ptyMax: 4,
  /** Протокол 8: таймаут простоя PTY-сессии, мс (2 дня). */
  ptyIdleMs: 172_800_000,
  /** Протокол 8: потолок тела ввода PTY, байт. */
  ptyInputMaxBytes: 16 * 1024,
} as const;

/** Провайдер внешнего чекера команд (PROP-136b). */
export type CommandPolicyProviderName = 'off' | 'http' | 'opa';

/** Поведение при недоступном чекере команд. */
export type CommandPolicyFailMode = 'closed' | 'open';

/**
 * Конфигурация внешнего чекера команд (PROP-136b).
 *
 * Значение bearer-токена здесь **не** хранится: только путь к файлу
 * (`tokenFile`); сам токен читает `createCommandPolicyGuard` при старте.
 */
export interface CommandPolicyConfig {
  /** Провайдер: `off` — проверка не выполняется, guard не создаётся. */
  provider: CommandPolicyProviderName;
  /** Адрес чекера (обязателен при `http`/`opa`). */
  url?: string;
  /** Файл bearer-токена чекера (путь; необязателен). */
  tokenFile?: string;
  /** `closed` — недоступность чекера значит `deny`; `open` — `allow`. */
  failMode: CommandPolicyFailMode;
  /** Таймаут запроса к чекеру, мс. */
  timeoutMs: number;
  /** TTL кэша вердиктов, мс (`0` — без кэша). */
  cacheTtlMs: number;
  /** Путь OPA-решения (`provider: opa`). */
  opaPath: string;
}

/**
 * Конфигурация контура PTY-сессий (протокол 8).
 *
 * Отдельный объект — параметры связаны (лимит сессий, их простой и потолок
 * ввода), и держать их в плоских полях `ExecutorConfig` было бы шумом.
 */
export interface PtyConfig {
  /** Включён ли контур PTY (`false` → `501 pty_unsupported` на всех роутах). */
  enabled: boolean;
  /** Лимит **живых** PTY-сессий (превышение → `429 pty_limit`). */
  maxSessions: number;
  /** Таймаут простоя сессии, мс (idle-reaper закрывает зависший терминал). */
  idleTimeoutMs: number;
  /** Потолок тела ввода терминала, байт (превышение → `413`). */
  inputMaxBytes: number;
}

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
  /**
   * Внешний чекер команд (PROP-136b): `allow`/`deny` **до** запуска команды.
   * `provider: 'off'` — проверка выключена.
   */
  commandPolicy: CommandPolicyConfig;
  /** Контур PTY-сессий (протокол 8). */
  pty: PtyConfig;
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
 * Разбор строкового значения из закрытого набора (строгий).
 *
 * Невалидное **явное** значение — ошибка старта: опечатка в режиме чекера
 * политик не должна молча превращаться в дефолт (`off` — «проверки нет»,
 * `open` — «пропускать при сбое»), иначе оператор считал бы защиту включённой.
 */
function resolveChoiceEnv<T extends string>(
  raw: string | undefined,
  envName: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  if ((allowed as readonly string[]).includes(trimmed)) return trimmed as T;
  throw new Error(
    `[executor] невалидное значение ${envName}="${raw}" — ожидается одно из: ${allowed.join(', ')}`,
  );
}

/** Неотрицательное целое из env (0 допустим — «выключено»). */
function resolveNonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `[executor] невалидное значение ${name}="${raw}" — ожидается целое число >= 0`,
    );
  }
  return value;
}

/**
 * Проверить, что файл читается (fail-closed на старте).
 *
 * @param path путь (пустая строка — «не задан»)
 * @param envName имя переменной (для понятного текста ошибки)
 * @param purpose назначение файла (для текста ошибки; без значения)
 */
function requireReadableFile(path: string, envName: string, purpose: string): string {
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(
      `[executor] ${envName}="${path}" — файл ${purpose} недоступен для чтения (исполнитель не стартует, fail-closed)`,
    );
  }
  return path;
}

/**
 * Разбор конфигурации внешнего чекера команд (PROP-136b).
 *
 * Правила:
 *
 * - `provider: off` — проверка выключена; прочие ключи игнорируются;
 * - `http`/`opa` требуют **адрес** (`..._URL`): без него чекер некуда звать —
 *   явная настройка провайдера без адреса опаснее выключенного чекера
 *   (оператор считал бы, что политика применяется) ⇒ ошибка старта;
 * - `failMode` — строго `closed`/`open` (дефолт `closed`: недоступность
 *   чекера означает запрет);
 * - таймаут обязателен (положительный), TTL кэша `0` — кэш выключен;
 * - `tokenFile` — только путь: значение токена читает guard при старте,
 *   в конфиг и env оно не попадает; нечитаемый файл — ошибка старта.
 */
export function resolveCommandPolicyConfig(
  env: NodeJS.ProcessEnv = process.env,
): CommandPolicyConfig {
  const provider = resolveChoiceEnv(
    env[EXECUTOR_ENV.commandPolicyProvider],
    EXECUTOR_ENV.commandPolicyProvider,
    ['off', 'http', 'opa'] as const,
    EXECUTOR_DEFAULTS.commandPolicyProvider,
  );
  const failMode = resolveChoiceEnv(
    env[EXECUTOR_ENV.commandPolicyFailMode],
    EXECUTOR_ENV.commandPolicyFailMode,
    ['closed', 'open'] as const,
    EXECUTOR_DEFAULTS.commandPolicyFailMode,
  );
  const timeoutMs = requirePositiveInt(
    env,
    EXECUTOR_ENV.commandPolicyTimeoutMs,
    EXECUTOR_DEFAULTS.commandPolicyTimeoutMs,
  );
  const cacheTtlMs = resolveNonNegativeInt(
    env,
    EXECUTOR_ENV.commandPolicyCacheTtlMs,
    EXECUTOR_DEFAULTS.commandPolicyCacheTtlMs,
  );
  const rawOpaPath =
    env[EXECUTOR_ENV.commandPolicyOpaPath]?.trim() || EXECUTOR_DEFAULTS.commandPolicyOpaPath;
  if (!rawOpaPath.startsWith('/')) {
    throw new Error(
      `[executor] невалидное значение ${EXECUTOR_ENV.commandPolicyOpaPath}="${rawOpaPath}" — путь должен начинаться с "/"`,
    );
  }
  const config: CommandPolicyConfig = {
    provider,
    failMode,
    timeoutMs,
    cacheTtlMs,
    opaPath: rawOpaPath,
  };
  if (provider === 'off') return config;

  const rawUrl = env[EXECUTOR_ENV.commandPolicyUrl]?.trim();
  if (rawUrl === undefined || rawUrl.length === 0) {
    throw new Error(
      `[executor] ${EXECUTOR_ENV.commandPolicyProvider}="${provider}" требует адрес чекера (${EXECUTOR_ENV.commandPolicyUrl}) — исполнитель не стартует (fail-closed)`,
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(
      `[executor] невалидное значение ${EXECUTOR_ENV.commandPolicyUrl}="${rawUrl}" — ожидается http(s)-адрес`,
    );
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `[executor] невалидное значение ${EXECUTOR_ENV.commandPolicyUrl}="${rawUrl}" — поддерживаются только http/https`,
    );
  }
  config.url = rawUrl.replace(/\/+$/, '');

  const tokenFile = env[EXECUTOR_ENV.commandPolicyTokenFile]?.trim();
  if (tokenFile !== undefined && tokenFile.length > 0) {
    config.tokenFile = requireReadableFile(
      tokenFile,
      EXECUTOR_ENV.commandPolicyTokenFile,
      'токена чекера команд',
    );
  }
  return config;
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
    // PROP-136b: внешний чекер команд (до spawn). `off` — проверки нет.
    commandPolicy: resolveCommandPolicyConfig(env),
    // Протокол 8: контур PTY-сессий.
    pty: resolvePtyConfig(env),
  };
}

/**
 * Разбор конфигурации контура PTY (протокол 8).
 *
 * `SYNTH_EXECUTOR_PTY` — строгий булев: `true`/`false`/`1`/`0`. Невалидное
 * значение — **ошибка старта** (fail-closed): молчаливый выключенный PTY
 * выглядел бы как «исполнитель не умеет терминал», а на деле это опечатка
 * оператора.
 */
export function resolvePtyConfig(env: NodeJS.ProcessEnv = process.env): PtyConfig {
  return {
    enabled: resolveBooleanEnv(env[EXECUTOR_ENV.pty], EXECUTOR_ENV.pty, EXECUTOR_DEFAULTS.ptyEnabled),
    maxSessions: requirePositiveInt(env, EXECUTOR_ENV.ptyMax, EXECUTOR_DEFAULTS.ptyMax),
    idleTimeoutMs: requirePositiveInt(env, EXECUTOR_ENV.ptyIdleMs, EXECUTOR_DEFAULTS.ptyIdleMs),
    inputMaxBytes: requirePositiveInt(
      env,
      EXECUTOR_ENV.ptyInputMaxBytes,
      EXECUTOR_DEFAULTS.ptyInputMaxBytes,
    ),
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

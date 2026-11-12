/**
 * Конфигурация provisioner'а из env (PROP-135, Ф4b-2a).
 *
 * Provisioner — отдельный процесс (как исполнитель), поэтому конфигурация —
 * **только env**: у него нет доступа к каталогу данных инстанса.
 *
 * | Переменная | Обязательна | По умолчанию | Назначение |
 * |---|---|---|---|
 * | `SYNTH_PROVISIONER_TOKEN` | **да** | — | bearer-токен control plane |
 * | `SYNTH_PROVISIONER_HOST` | нет | `0.0.0.0` | адрес прослушивания |
 * | `SYNTH_PROVISIONER_PORT` | нет | `5200` | порт прослушивания |
 * | `SYNTH_PROVISIONER_PROVIDER` | нет | `static` | провайдер пулов (`static`) |
 * | `SYNTH_PROVISIONER_PROFILES` | нет | `{}` | профили: `{"<profile>":{"url":…}}` |
 * | `SYNTH_PROVISIONER_STATIC_POOLS` | нет | `{}` | точные пулы: `{"<poolKey>":"http://…"}` |
 * | `SYNTH_PROVISIONER_IDLE_TIMEOUT_MS` | нет | `900000` | idle-таймаут проектного пула |
 * | `SYNTH_PROVISIONER_SESSION_IDLE_TIMEOUT_MS` | нет | `300000` | idle-таймаут сессионного пула |
 * | `SYNTH_PROVISIONER_MAX_LIFETIME_MS` | нет | `43200000` | предельное время жизни пула |
 * | `SYNTH_PROVISIONER_DRAIN_GRACE_MS` | нет | `30000` | пауза между drain и release |
 * | `SYNTH_PROVISIONER_MAX_POOLS` | нет | `50` | лимит живых пулов (`429` сверх) |
 * | `SYNTH_PROVISIONER_REAPER_INTERVAL_MS` | нет | `30000` | период уборщика |
 *
 * **Fail-closed**: без токена процесс не стартует — provisioner без
 * аутентификации поднимал бы исполнителей по анонимному запросу. Битый JSON,
 * неизвестный `provider`, профиль без `url` (в static-режиме), нечисловые
 * значения — тоже ошибка старта: явная настройка оператора не должна молча
 * превращаться в дефолт.
 *
 * `kubernetes` в 4b-2a **не реализован** — попытка выбрать его даёт понятную
 * ошибку старта, а не «молча пустой» provisioner.
 *
 * Токен читается один раз и удаляется из `process.env`
 * (`scrubProvisionerToken`): в окружении дочерних процессов (в будущем —
 * kubectl-вызовов) ему делать нечего. Значение токена нигде не логируется.
 */

import { z } from 'zod';
import { formatIssues } from './protocol.js';

/** Env-имена provisioner'а. */
export const PROVISIONER_ENV = {
  token: 'SYNTH_PROVISIONER_TOKEN',
  host: 'SYNTH_PROVISIONER_HOST',
  port: 'SYNTH_PROVISIONER_PORT',
  provider: 'SYNTH_PROVISIONER_PROVIDER',
  profiles: 'SYNTH_PROVISIONER_PROFILES',
  staticPools: 'SYNTH_PROVISIONER_STATIC_POOLS',
  idleTimeoutMs: 'SYNTH_PROVISIONER_IDLE_TIMEOUT_MS',
  sessionIdleTimeoutMs: 'SYNTH_PROVISIONER_SESSION_IDLE_TIMEOUT_MS',
  maxLifetimeMs: 'SYNTH_PROVISIONER_MAX_LIFETIME_MS',
  drainGraceMs: 'SYNTH_PROVISIONER_DRAIN_GRACE_MS',
  maxPools: 'SYNTH_PROVISIONER_MAX_POOLS',
  reaperIntervalMs: 'SYNTH_PROVISIONER_REAPER_INTERVAL_MS',
} as const;

/** Дефолты provisioner'а. */
export const PROVISIONER_DEFAULTS = {
  host: '0.0.0.0',
  port: 5200,
  provider: 'static',
  idleTimeoutMs: 900_000,
  sessionIdleTimeoutMs: 300_000,
  maxLifetimeMs: 43_200_000,
  drainGraceMs: 30_000,
  maxPools: 50,
  reaperIntervalMs: 30_000,
} as const;

/** http(s)-URL: единственная схема, которую понимает transport портов. */
const httpUrlSchema = z.string().trim().min(1).refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'ожидается http(s)-URL' },
);

/** Ресурсы профиля (используются Kubernetes-провайдером, 4b-2b). */
const resourcesSchema = z
  .object({
    cpu: z.string().trim().min(1).optional(),
    memory: z.string().trim().min(1).optional(),
    ephemeralStorage: z.string().trim().min(1).optional(),
  })
  .strict();

/** Описание профиля исполнения. */
export const profileSchema = z
  .object({
    image: z.string().trim().min(1).optional(),
    url: httpUrlSchema.optional(),
    network: z.enum(['none', 'restricted', 'full']).optional(),
    resources: resourcesSchema.optional(),
  })
  .strict();

/** Каталог профилей: имя профиля → описание. */
export const profilesSchema = z.record(z.string().trim().min(1), profileSchema);

/** Точные пулы: канонический ключ пула → адрес исполнителя. */
export const staticPoolsSchema = z.record(z.string().trim().min(1), httpUrlSchema);

/** Описание профиля из env. */
export type ProvisionerProfile = z.output<typeof profileSchema>;

/** Каталог профилей из env. */
export type ProvisionerProfiles = z.output<typeof profilesSchema>;

/** Эффективная конфигурация provisioner'а. */
export interface ProvisionerConfig {
  /** Bearer-токен control plane (в логи не пишется). */
  token: string;
  /** Адрес прослушивания. */
  host: string;
  /** Порт прослушивания. */
  port: number;
  /** Провайдер пулов; в 4b-2a реализован только `static`. */
  provider: 'static';
  /** Каталог профилей исполнения. */
  profiles: ProvisionerProfiles;
  /** Точные пулы (тесты/дев): ключ → адрес. */
  staticPools: Record<string, string>;
  /** Idle-таймаут проектного/инстансного пула, мс. */
  idleTimeoutMs: number;
  /** Idle-таймаут сессионного пула, мс. */
  sessionIdleTimeoutMs: number;
  /** Предельное время жизни пула, мс. */
  maxLifetimeMs: number;
  /** Пауза между drain и release, мс. */
  drainGraceMs: number;
  /** Лимит живых пулов (сверх — `429`). */
  maxPools: number;
  /** Период уборщика, мс. */
  reaperIntervalMs: number;
}

/**
 * Разобрать JSON-значение env строгой схемой.
 *
 * @param raw значение env (пустое/незаданное — `fallback`)
 * @param envName имя переменной (для понятного текста ошибки)
 * @param schema схема значения
 * @param fallback значение по умолчанию
 */
export function parseJsonEnv<S extends z.ZodType>(
  raw: string | undefined,
  envName: string,
  schema: S,
  fallback: z.output<S>,
): z.output<S> {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `[provisioner] невалидный JSON в ${envName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`[provisioner] невалидное значение ${envName}: ${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Разобрать целое значение env (строго: мусор — ошибка старта). */
function resolveInt(
  raw: string | undefined,
  envName: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `[provisioner] невалидное значение ${envName}="${raw}" — ожидается целое число в ${min}..${max}`,
    );
  }
  return value;
}

/** Обязательная непустая строка env. */
function requireEnvString(env: NodeJS.ProcessEnv, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      `[provisioner] обязательная переменная ${name} не задана — provisioner не стартует (fail-closed)`,
    );
  }
  return raw.trim();
}

/**
 * Разобрать конфигурацию provisioner'а из env.
 *
 * @throws Error при отсутствии токена или невалидных значениях (fail-closed).
 */
export function resolveProvisionerConfig(env: NodeJS.ProcessEnv = process.env): ProvisionerConfig {
  const rawProvider = (env[PROVISIONER_ENV.provider] ?? '').trim() || PROVISIONER_DEFAULTS.provider;
  if (rawProvider === 'kubernetes') {
    throw new Error(
      '[provisioner] провайдер "kubernetes" не реализован в 4b-2a — доступен только "static" ' +
        `(${PROVISIONER_ENV.provider})`,
    );
  }
  if (rawProvider !== 'static') {
    throw new Error(
      `[provisioner] неизвестный provider "${rawProvider}" — ожидается "static" ` +
        `(${PROVISIONER_ENV.provider})`,
    );
  }

  const profiles = parseJsonEnv(
    env[PROVISIONER_ENV.profiles],
    PROVISIONER_ENV.profiles,
    profilesSchema,
    {},
  );
  // В static-режиме адрес профиля — единственный источник пула: профиль без
  // url сделал бы профиль «объявленным, но недоступным».
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.url === undefined) {
      throw new Error(
        `[provisioner] профиль "${name}" без url — в static-режиме url обязателен ` +
          `(${PROVISIONER_ENV.profiles})`,
      );
    }
  }

  const staticPools = parseJsonEnv(
    env[PROVISIONER_ENV.staticPools],
    PROVISIONER_ENV.staticPools,
    staticPoolsSchema,
    {},
  );

  if (Object.keys(profiles).length === 0 && Object.keys(staticPools).length === 0) {
    throw new Error(
      '[provisioner] не задано ни одного профиля и ни одного статического пула — ' +
        `provisioner не смог бы выдать ни одного пула (${PROVISIONER_ENV.profiles} / ${PROVISIONER_ENV.staticPools})`,
    );
  }

  const host = env[PROVISIONER_ENV.host]?.trim() || PROVISIONER_DEFAULTS.host;
  const port = resolveInt(env[PROVISIONER_ENV.port], PROVISIONER_ENV.port, PROVISIONER_DEFAULTS.port, 1, 65_535);

  return {
    token: requireEnvString(env, PROVISIONER_ENV.token),
    host,
    port,
    provider: 'static',
    profiles,
    staticPools,
    idleTimeoutMs: resolveInt(
      env[PROVISIONER_ENV.idleTimeoutMs],
      PROVISIONER_ENV.idleTimeoutMs,
      PROVISIONER_DEFAULTS.idleTimeoutMs,
    ),
    sessionIdleTimeoutMs: resolveInt(
      env[PROVISIONER_ENV.sessionIdleTimeoutMs],
      PROVISIONER_ENV.sessionIdleTimeoutMs,
      PROVISIONER_DEFAULTS.sessionIdleTimeoutMs,
    ),
    maxLifetimeMs: resolveInt(
      env[PROVISIONER_ENV.maxLifetimeMs],
      PROVISIONER_ENV.maxLifetimeMs,
      PROVISIONER_DEFAULTS.maxLifetimeMs,
    ),
    drainGraceMs: resolveInt(
      env[PROVISIONER_ENV.drainGraceMs],
      PROVISIONER_ENV.drainGraceMs,
      PROVISIONER_DEFAULTS.drainGraceMs,
    ),
    maxPools: resolveInt(
      env[PROVISIONER_ENV.maxPools],
      PROVISIONER_ENV.maxPools,
      PROVISIONER_DEFAULTS.maxPools,
    ),
    reaperIntervalMs: resolveInt(
      env[PROVISIONER_ENV.reaperIntervalMs],
      PROVISIONER_ENV.reaperIntervalMs,
      PROVISIONER_DEFAULTS.reaperIntervalMs,
    ),
  };
}

/**
 * Убрать токен из `process.env` после чтения конфигурации.
 *
 * Provisioner не запускает дочерних процессов пользователя, но токен в
 * окружении не нужен никому: значение остаётся только в памяти процесса
 * (`ProvisionerConfig.token`).
 */
export function scrubProvisionerToken(env: NodeJS.ProcessEnv = process.env): void {
  delete env[PROVISIONER_ENV.token];
}

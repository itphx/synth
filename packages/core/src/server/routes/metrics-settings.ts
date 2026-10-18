/**
 * ADR-094: админ-раздел «Наблюдаемость» — runtime-настройки экспорта метрик
 * и живой статус подсистемы.
 *
 * Контракт (UI пишется параллельно):
 * - `GET    /api/v2/settings/metrics` — эффективное значение + источник + статус;
 * - `PUT    /api/v2/settings/metrics` `{metrics:{enabled:boolean}}` — runtime-override;
 * - `DELETE /api/v2/settings/metrics` — сброс runtime к config/env/default;
 * - `GET    /api/v2/settings/metrics/status` — live-снимок (readiness, хранилище,
 *   версия, uptime, объём exposition, токен);
 * - `PUT    /api/v2/settings/metrics/token` `{token:string}` — запись файла токена
 *   (write-only, применяется сразу: `/metrics` читает файл на каждый запрос);
 * - `DELETE /api/v2/settings/metrics/token` — удаление файла токена.
 *
 * Приоритет эффективного значения: env `SYNTH_METRICS_ENABLED` > runtime
 * (`settings.json`) > config.yaml `metrics.enabled` > default `false`.
 * `running` — значение, с которым стартовал процесс; `restartRequired` =
 * `effective !== running` (переключение сбора — только рестартом процесса).
 * Токен меняется без рестарта; при env-токене PUT/DELETE → 409 `CONFLICT`
 * (env приоритетнее и не перезаписывается из UI).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { createMiddleware } from 'hono/factory';
import type { SettingsRepository } from '../../storage/ports/settings-repository.js';
import { SERIES_DROPPED_METRIC, type MetricsRegistry } from '../../metrics/registry.js';
import {
  MIN_METRICS_TOKEN_LENGTH,
  getMetricsTokenStatus,
  removeMetricsToken,
  writeMetricsToken,
  type MetricsTokenStatus,
} from '../../metrics/token.js';

/** Тип middleware, совпадающий с core/backend AuthKit (оба на `createMiddleware`). */
type Middleware = ReturnType<typeof createMiddleware>;

/** Источник эффективного значения `metrics.enabled`. */
export type MetricsSource = 'env' | 'runtime' | 'config' | 'default';

/** Live-состояние readiness (паритет с `GET /ready`). */
export interface MetricsReadiness {
  ready: boolean;
  storage: 'ok' | 'degraded';
}

/** Зависимости фабрики. */
export interface MetricsSettingsDeps {
  /** Порт runtime-настроек (`{dataDir}/settings.json` / PG). */
  settingsStore: SettingsRepository;
  /** Каталог данных — файл `{dataDir}/secrets/metrics-token`. */
  dataDir: string;
  /**
   * Базовое значение из config/env (без runtime): `metrics.enabled` после
   * применения `SYNTH_METRICS_ENABLED`. Используется для `defaults` и источника
   * `config`/`default`.
   */
  configEnabled: boolean;
  /** Фактический флаг старта процесса (`metricsEnabled`). */
  runningEnabled: boolean;
  /** Реестр метрик (нет — экспорт выключен/реестр не подключён → нули). */
  getRegistry?: () => MetricsRegistry | undefined;
  /** Live-readiness (`GET /ready`). */
  getReadiness: () => MetricsReadiness;
  /** Физический backend хранения (`file`|`memory`|`postgres`). */
  getStorageBackend: () => string;
  /** Uptime процесса в секундах. */
  getUptimeSec: () => number;
  /** Версия приложения (`SYNTH_VERSION`). */
  version: string;
  /** Env (тесты); по умолчанию `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** i18n-сообщения (backend передаёт `t(...)`; core — русские дефолты). */
export interface MetricsSettingsMessages {
  invalidEnabled?: (c: Context) => string;
  invalidToken?: (c: Context) => string;
  tokenFromEnv?: (c: Context) => string;
}

/** Опции фабрики: guard'ы и сообщения. */
export interface MetricsSettingsOptions {
  /**
   * Guard чтения (`GET /metrics`, `GET /metrics/status`); по умолчанию —
   * `auth.requireAuth`. Managed backend передаёт `requirePermission('ADMIN')`.
   */
  readGuard?: Middleware;
  /**
   * Guard на мутации (`PUT/DELETE /metrics`, `PUT/DELETE /metrics/token`);
   * по умолчанию — переданный `auth.requireAuth` (core), managed backend —
   * `requirePermission('ADMIN')`.
   */
  writeGuard?: Middleware;
  messages?: MetricsSettingsMessages;
}

const DEFAULT_INVALID_ENABLED = 'metrics.enabled: ожидается boolean';
const DEFAULT_INVALID_TOKEN = `metrics.token: ожидается непустая строка не короче ${MIN_METRICS_TOKEN_LENGTH} символов`;
const DEFAULT_TOKEN_FROM_ENV = 'Токен /metrics задан через SYNTH_METRICS_TOKEN (env) — изменение из UI недоступно';

const ENDPOINTS = { metrics: '/metrics', ready: '/ready' } as const;

/** Разбор env-флага `SYNTH_METRICS_ENABLED` (как `applyEnvOverrides`: true/1, false/0). */
export function parseMetricsEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env.SYNTH_METRICS_ENABLED;
  if (raw === undefined || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Эффективное значение `metrics.enabled` и его источник.
 * `configEnabled` — уровень config/env (без runtime).
 */
export function resolveMetricsEnabled(params: {
  configEnabled: boolean;
  runtimeEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
}): { enabled: boolean; source: MetricsSource } {
  const fromEnv = parseMetricsEnvEnabled(params.env ?? process.env);
  if (fromEnv !== undefined) return { enabled: fromEnv, source: 'env' };
  if (params.runtimeEnabled !== undefined) return { enabled: params.runtimeEnabled, source: 'runtime' };
  if (params.configEnabled) return { enabled: true, source: 'config' };
  return { enabled: false, source: 'default' };
}

/** Суммарный `synth_metrics_series_dropped_total` из снимка реестра. */
function readDroppedSeries(registry: MetricsRegistry): number {
  const metric = registry.snapshot().find((m) => m.name === SERIES_DROPPED_METRIC);
  if (!metric) return 0;
  return metric.series.reduce((sum, series) => sum + series.value, 0);
}

/**
 * Фабрика роутов админ-раздела «Наблюдаемость».
 * `auth.requireAuth` — обязательный guard чтения по умолчанию.
 */
export function createMetricsSettingsRoutes(
  auth: { requireAuth: Middleware },
  deps: MetricsSettingsDeps,
  opts: MetricsSettingsOptions = {},
): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const readGuard = opts.readGuard ?? auth.requireAuth;
  const writeGuard = opts.writeGuard ?? auth.requireAuth;
  const invalidEnabled = opts.messages?.invalidEnabled ?? (() => DEFAULT_INVALID_ENABLED);
  const invalidToken = opts.messages?.invalidToken ?? (() => DEFAULT_INVALID_TOKEN);
  const tokenFromEnv = opts.messages?.tokenFromEnv ?? (() => DEFAULT_TOKEN_FROM_ENV);

  const tokenStatus = (): MetricsTokenStatus => getMetricsTokenStatus(deps.dataDir, env);

  /** Снимок настроек: значение, дефолт, источник, running/restart, токен. */
  const buildView = async () => {
    const runtime = await deps.settingsStore.getMetrics();
    const runtimeEnabled = typeof runtime.enabled === 'boolean' ? runtime.enabled : undefined;
    const { enabled, source } = resolveMetricsEnabled({
      configEnabled: deps.configEnabled,
      runtimeEnabled,
      env,
    });
    return {
      metrics: { enabled },
      defaults: { enabled: deps.configEnabled },
      isOverridden: runtimeEnabled !== undefined,
      source,
      running: deps.runningEnabled,
      restartRequired: enabled !== deps.runningEnabled,
      token: tokenStatus(),
      endpoints: { ...ENDPOINTS },
    };
  };

  const tokenResponse = () => ({ token: tokenStatus() });

  /**
   * ADR-094: настройки наблюдаемости (эффективное значение + источник).
   * Read — `requireAuth` (core) / ADMIN (managed), mutations — writeGuard.
   */
  app.get('/metrics', readGuard, async (c) => c.json(await buildView()));

  app.put('/metrics', writeGuard, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const value = (body as { metrics?: unknown }).metrics;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: invalidEnabled(c) } },
        400,
      );
    }
    const enabled = (value as { enabled?: unknown }).enabled;
    if (typeof enabled !== 'boolean') {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: invalidEnabled(c) } },
        400,
      );
    }

    await deps.settingsStore.setMetrics({ enabled });
    return c.json(await buildView());
  });

  app.delete('/metrics', writeGuard, async (c) => {
    await deps.settingsStore.clearMetrics();
    return c.json(await buildView());
  });

  /**
   * Live-статус подсистемы: readiness/хранилище/версия/uptime и объём
   * exposition (series/bytes/droppedSeries). Не меняет состояние.
   */
  app.get('/metrics/status', readGuard, async (c) => {
    const runtime = await deps.settingsStore.getMetrics();
    const runtimeEnabled = typeof runtime.enabled === 'boolean' ? runtime.enabled : undefined;
    const { enabled, source } = resolveMetricsEnabled({
      configEnabled: deps.configEnabled,
      runtimeEnabled,
      env,
    });
    const { ready, storage } = deps.getReadiness();
    const registry = deps.getRegistry?.();

    let series = 0;
    let bytes = 0;
    let droppedSeries = 0;
    if (registry) {
      const rendered = registry.render();
      series = rendered.series;
      bytes = Buffer.byteLength(rendered.text, 'utf8');
      droppedSeries = readDroppedSeries(registry);
    }

    return c.json({
      enabled,
      running: deps.runningEnabled,
      source,
      restartRequired: enabled !== deps.runningEnabled,
      ready,
      storage,
      storageBackend: deps.getStorageBackend(),
      version: deps.version,
      uptimeSec: deps.getUptimeSec(),
      exposition: { series, bytes, droppedSeries },
      token: tokenStatus(),
      endpoints: { ...ENDPOINTS },
    });
  });

  /**
   * Bearer-токен `/metrics` (write-only): значение не возвращается.
   * При env-токене (`SYNTH_METRICS_TOKEN`) изменение запрещено — 409.
   */
  app.put('/metrics/token', writeGuard, async (c) => {
    if (tokenStatus().source === 'env') {
      return c.json(
        { error: { code: 'CONFLICT', message: tokenFromEnv(c) } },
        409,
      );
    }
    const body = await c.req.json().catch(() => ({}));
    const token = (body as { token?: unknown }).token;
    if (typeof token !== 'string' || token.trim().length < MIN_METRICS_TOKEN_LENGTH) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: invalidToken(c) } },
        400,
      );
    }

    await writeMetricsToken(deps.dataDir, token);
    return c.json(tokenResponse());
  });

  app.delete('/metrics/token', writeGuard, async (c) => {
    if (tokenStatus().source === 'env') {
      return c.json(
        { error: { code: 'CONFLICT', message: tokenFromEnv(c) } },
        409,
      );
    }
    await removeMetricsToken(deps.dataDir);
    return c.json(tokenResponse());
  });

  return app;
}
